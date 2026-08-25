# Cross-Platform Validation

This page defines the procedure common to every native desktop validation.
Pair it with the [Windows](./windows-desktop.md),
[Linux](./linux-desktop.md), or [macOS](./macos-desktop.md) runbook.

## Inputs

Before starting, record the requested:

- repository and remote;
- branch or exact revision;
- required ancestor commits, if any;
- expected product version, if any;
- native operating system and architecture;
- features, regressions, and user scenarios in scope; and
- permission boundaries for commits, pushes, merges, installations, system
  settings, credentials, and external services.

Inputs are execution data. Do not edit the living runbooks to insert them.

## Required pre-work

1. Read every applicable `AGENTS.md` from the repository root to the affected
   files.
2. Run `git status --short` and preserve unrelated changes.
3. State the requested outcome, constraints, affected packages, and completion
   evidence.
4. Follow the CodeGraph setup and fallback rules in `AGENTS.md`.
5. Read `docs/README.md`, the architecture overview, workspace layout, scripts
   reference, relevant living documents, package manifests, tests, and CI.
6. Inspect recent history for affected paths when intent is unclear.

Do not install, repair, or re-index repository tools outside the authority
granted by `AGENTS.md` and the current request.

## Revision and worktree preflight

Use GitHub CLI for GitHub metadata and Git for worktree/revision operations.
A typical read-only preflight is:

```sh
git status --short
git branch --show-current
git rev-parse HEAD
gh repo view --json nameWithOwner
gh api "repos/OWNER/REPOSITORY/git/ref/heads/BRANCH"
git fetch origin BRANCH
git rev-list --left-right --count "origin/BRANCH...HEAD"
```

Replace the uppercase input tokens for the current execution. Quote branch
names when the shell requires it. Fast-forward only a clean worktree and only
when the request authorizes updating it. Never force-checkout, reset, rewrite,
or overwrite unrelated changes to reach a requested revision.

For every required commit:

```sh
git merge-base --is-ancestor REQUIRED_COMMIT HEAD
```

Stop when a required revision or expected version is absent. Do not test an
older substitute or recreate a missing change from memory. Record local HEAD,
remote HEAD, merge base, ahead/behind counts, required ancestry, and the version
sources used by the affected packages.

## Source-of-truth audit

Trace the feature from public behavior to its owner before selecting tests.
Inspect:

- package scripts and workspace manifests;
- relevant source, schemas, persisted formats, and public contracts;
- focused unit and integration tests;
- `.github/workflows/ci.yml`, native desktop smoke, and release workflows;
- [repository scripts](../reference/scripts.md);
- [CI quality gates](../operations/ci.md); and
- [release process](../operations/release.md) for native artifact support.

Check platform boundaries explicitly: filesystem identity, path spelling,
process ownership, environment presentation, desktop bridge operations,
provider availability, network trust, cancellation, restart, duplicate
delivery, partial streams, and cleanup.

## Focused tests

Run the closest behavioral coverage before broad suites. Discover exact Rust
targets and filters from manifests and `cargo test -- --list`; do not invent
test names. When concurrency matters, run the affected owner at its default
harness width and at the repository's relevant explicit parallel widths.

Use `vp test` for the built-in Vite+ test command. Use `vp run test` only when
the workspace package-script graph is required. Exact subprocess tests may
select a single thread only when the subprocess intentionally owns isolated
process-global state, as documented in the repository scripts reference.

A focused suite must cover the changed success behavior and its material
failure, cancellation, retry, restart, and cleanup seams. For cross-platform
logic, include host-independent fixtures for every affected platform.

### Environment, project, and Main invariant evidence

When environment identity, project admission, project navigation, or thread
kind behavior changes, use disposable roots and repositories and record:

- `environmentId` and `storageInstanceId` before and after restart and in-place
  restore; both remain stable and distinct. Record new UUIDs after explicit
  start-empty without copying machine-specific values into this runbook;
- one add of a Git repository returning `created`, then the same path and one
  linked worktree returning `existing` with the same project/Main IDs;
- an independent clone of the same remote in that environment returning
  `created`, and the same repository on another environment remaining an
  independent project;
- exactly one active `kind = "default"` row per project after migration,
  restart, and projection replay, plus rejected Main rename/archive/delete;
- an ambiguous legacy Main fixture failing migration with its project/thread
  IDs rather than deleting or selecting data; and
- the unchanged worktree discovery, adoption, detach, retarget, removal, replay,
  and cleanup suite result.

Project/thread/cache/navigation assertions must always include the accepted
environment identity. Do not use host label, distro, SSH target, path, remote
URL, or project count as identity or availability evidence.

### Environment catalog, route, secret, cache, and cleanup evidence

When normalized connection persistence, route selection, protected secrets,
offline cache, or environment removal changes, run the current owners together:

```sh
vp test run apps/web/src/connection/catalogMigration.test.ts apps/web/src/connection/storage.test.ts packages/client-runtime/src/connection/catalog.test.ts packages/client-runtime/src/connection/routeSelection.test.ts packages/client-runtime/src/connection/supervisor.test.ts packages/client-runtime/src/connection/registry.test.ts
node scripts/run-msvc-x64.mjs cargo test -p bibcode-desktop secret_store -- --nocapture
```

On a non-Windows native host, use direct Cargo for the Rust filter. Record the
test names and totals, not only the file result. The fixtures and native scenario
must prove each of these cases:

1. **v1 direct:** a legacy HTTPS entry with an accepted storage UUID becomes one
   normalized environment and route. Its bearer value stays outside metadata,
   an OS-secret reference is created before publication, and exactly one
   migration receipt survives retry after an injected abort. A loopback HTTP
   entry may become a loopback route; non-loopback HTTP is quarantined.
2. **v1 Relay-only:** the migration produces no environment, route, credential,
   or DPoP row; it records only discarded counts and a receipt. Assert that no
   token or endpoint secret appears in metadata or diagnostics.
3. **Corrupt input:** invalid catalog or row data remains isolated, cannot become
   an empty authoritative project catalog, and yields only a bounded fingerprint
   and stable code. Recovery requires an explicit reset or valid retry.
4. **Secret provider unavailable or locked:** enrollment/migration fails closed
   before normalized publication. No credential falls back to IndexedDB, no
   receipt claims success, and error output contains no value or native path.
5. **Private cache:** a durable snapshot is ciphertext; a valid envelope cannot
   be read under another environment, storage UUID, entity kind, or entity ID.
   Tampered ciphertext is quarantined, stale revisions are rejected, and an
   unavailable durable key selects documented `session-only` behavior or purges
   now-unreadable rows.
6. **Duplicate IDs across environments:** an existing globally keyed route ID
   or proved binding cannot be published for a second environment. The first
   aggregate remains byte-for-byte authoritative and no partial second row is
   visible.
7. **Failover:** with two eligible routes, a transient first-route failure tries
   the second route in the same cycle and publishes exactly one active session.
   A blocked route is skipped until explicit retry or credentials change.
8. **Offline and stale generations:** going offline cancels in-flight work,
   retains encrypted cache as non-authoritative presentation data, and starts no
   new transport. Success, failure, progress, or reconciliation from an older
   environment/route/admission generation cannot replace current state or
   resurrect forgotten metadata.
9. **Forget:** verify the visible order `close admission -> cancel supervisor ->
await scope -> delete secrets -> clear cache/UI -> delete routes/bindings ->
delete environment`. Inject a secret failure and a transaction abort; the
   redacted repair receipt must keep restart admission closed, all rows must
   survive an abort, and one retry must remove every environment-owned row and
   the receipt.

For a packaged native run, exercise Hide/restore without a reconnect, remove one
route while retaining the other route and projects, then Forget using only a
disposable remote. Inspect the OS credential provider through platform-approved
metadata or test APIs only; never reveal or copy secret values into evidence.
After restart, confirm a pending cleanup receipt prevents connection attempts
until retry. After successful Forget, confirm that the remote server and its
projects/worktrees/data still exist because local Forget is not host purge.

### Protected local-control evidence

When the control protocol, authentication bootstrap, service/update lifecycle,
server startup/shutdown, or state paths change, run:

```sh
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test local_control -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test cli_smoke -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test server_runtime -- --nocapture
```

On non-Windows hosts, replace the launcher with direct Cargo. Record same-user
success; wrong UID/SID and remote-client rejection; Unix parent/socket
ownership and modes or the Windows explicit DACL; stale endpoint replacement;
oversize, partial, unsupported-version, unknown-command, timeout, and disconnect
outcomes; response-before-stop ordering; concurrent shutdown/drain; owned Unix
unlink; and secret-free debug/error output. A Windows-target type-check on
another host is compatibility evidence only: named-pipe ACL, remote rejection,
impersonation/revert, and administrator/service-account admission require a
native Windows run.

For pairing CLI changes, also record exact nested parsing, human and one-line
JSON output, five-minute expiry, fixed non-Relay administrator scopes, wrong
data root versus stopped server, inaccessible endpoint, invalid/expired reply,
request/response identity matching, URL-fragment validation, and absence of the
credential from stderr. Confirm the client never calls an HTTP pairing route as
a fallback.

### Pairing and session-security evidence

When pairing persistence, token exchange, DPoP, authorized-client management,
or WebSocket admission changes, run:

```sh
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --lib auth::service::tests -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test repositories auth_pairing_links_consume_and_revoke_atomically -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test auth_http -- --nocapture
vp test packages/contracts/src/auth.test.ts packages/contracts/src/authRustParity.test.ts packages/contracts/scripts/export-rust-auth-fixtures.test.ts
vp test apps/web/src/components/settings/ConnectionsSettings.test.tsx apps/web/src/authBootstrap.test.ts
```

On a non-Windows host, use direct Cargo. Prove that the creation response is the
only administrative response containing the raw pairing value; SQLite, WAL
sidecars, migration-created backups, access snapshots/events, list responses,
and public errors contain no raw value. Migration 48 must rebuild the table
without `credential`, hash legacy values, truncate the WAL, and avoid creating
a plaintext-preserving pre-migration backup. Do not claim that backups created
by older application versions were rewritten or purged.

Also record five-minute expiry; a two-proof-key consumption race; same-key
lost-response idempotency; different-key and proofless rejection; bounded
64-attempt/one-minute admission that does not consume a valid code; exact DPoP
method/URL, timestamp, token-hash, and replay checks (including restart);
bounded session, pairing, receipt, and WebSocket-ticket state; one-use ticket
admission; and immediate socket close after client revocation. The settings UI
must warn that access is full administrator with no permission levels, reveal a
new credential once, and show only metadata/fingerprint afterward.

### Listener, service, and update lifecycle evidence

When listener admission, service definitions, host authority, managed process
state, or update handoff changes, run the focused owners before broad gates:

```sh
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test network_admission -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test service_lifecycle -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test production_control -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test production_maintenance -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test local_control -- --nocapture
```

On non-Windows hosts, replace the launcher with direct Cargo. The native run
must record:

- numeric loopback HTTP admission and rejection of every plain non-loopback
  HTTP configuration, with no insecure override in CLI/help or UI;
- a real direct HTTPS bind, certificate chain/hostname/date validation, system
  trust or the exact configured SPKI pin, DPoP verification against the HTTPS
  request URL, and rejection of a wrong/untrusted certificate;
- the exact listening address/port and process identity from an OS-native
  socket inspection tool;
- Unix `0700` parent/`0600` socket ownership and wrong-UID rejection, or the
  Windows explicit DACL, remote-client rejection, allowed SID/token, and
  impersonation/revert evidence;
- network `server.requestHostAction` rejection with the bounded allowed-channel
  list and no control endpoint, credential, environment variable, binary path,
  data path, or backup path in the public service view;
- workstation and headless status/install/start/stop/restart/uninstall for the
  native manager, including insufficient authority and exact definition
  mismatch/`--update` behavior;
- idempotent install, one live service instance, bounded stop/drain, no newly
  admitted mutation, and zero server-owned provider/terminal descendants after
  stop;
- partial fresh-install rollback, proof that a pre-existing service account is
  retained, and explicit reporting of any rollback failure;
- the same environment/storage IDs after service restart and prepared update
  restart, plus expected-version success and mismatched/interrupted
  `recoveryRequired` results;
- an expired/cancelled update lease, durable phase record, verified store
  backup, and redacted update view; and
- uninstall removal of native registration while the exact data root,
  environment marker, projects, repositories, and worktrees remain intact.

Run workstation and headless cases in separate disposable roots. Do not enable
Linux linger, create a system account, elevate, replace a real service, or
change system certificate trust without explicit authority. A simulated
adapter or cross-target check is compatibility evidence only; Task Scheduler,
SCM, launchd, systemd, socket ACL, and certificate behavior require the named
native host.

### WSL provisioning evidence

On native Windows with an explicitly disposable Running distribution, record
the authoritative discovery and setup generations, probed architecture, target
version, signed manifest/artifact tuple, byte count, managed destination, and
data root. Do not record credentials or raw environment output. Prove that a
stopped distro is not started, consent is one-use, concurrent same-distro setup
is rejected, and declining performs no mutation.

Exercise wrong architecture, manifest signature, artifact signature, size,
SHA-256, missing `tar`, insufficient space, mid-stream cancellation, atomic
switch failure, restart failure, and descriptor version/platform/protocol/
identity mismatch. Record whether exact staging paths were removed, the prior
`current` target remained or was restored, all setup children/I/O tasks were
joined, and no unrelated WSL process was signalled. A success must show the
managed `current` binary winning backend selection, numeric loopback on both
sides of the forward, and stable environment/storage identities. Separately
show that `BIBCODE_WSL_SERVER_BINARY` or the cross-compiled target fallback
still launches a development worktree when no managed runtime exists.

### SSH trust, descriptor, and pairing evidence

When SSH trust, launch, tunneling, descriptor verification, pairing, or route
enrollment changes, run the desktop SSH owner, bridge contract, connection
ordering, and onboarding tests together:

```sh
node scripts/run-msvc-x64.mjs cargo test -p bibcode-desktop remote_host:: --lib -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-desktop ssh::tests:: --lib -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-desktop --test ssh_public_contract -- --nocapture
vp test apps/web/src/connection/platform.test.ts apps/web/src/tauriDesktopBridge.test.ts packages/client-runtime/src/connection/resolver.test.ts packages/client-runtime/src/connection/onboarding.test.ts packages/contracts/src/ipc.test.ts
```

On non-Windows hosts, replace the launcher with direct Cargo. Use a disposable
SSH target for native evidence and record the actual OpenSSH client, effective
configuration source, host alias, port, and non-secret host-key fingerprint.
Never record passwords, private keys, pairing credentials, access tokens, or
raw command output that could contain them.

Prove the visible order `OpenSSH trust -> bounded OS/architecture/service probe
-> explicit one-use consent when setup is required -> exact signed artifact
download and local verification -> bounded transfer -> remote hash and size
verification -> atomic install -> requested loopback service -> numeric
loopback tunnel -> bounded canonical descriptor -> environment/storage/protocol
verification -> native pairing creation -> native redemption -> OS-secret
persistence -> session`. Declined or stale consent, an environment, storage,
protocol, platform, artifact, target, descriptor, or saved-host-fingerprint
mismatch must stop before pairing. The native pairing operation must preconnect
one TCP stream through the owned tunnel, refetch and require the exact verified
descriptor on that stream, create the credential only afterward, and redeem it
on that same stream. Close the forwarding listener after the descriptor
response and prove redemption still uses the accepted connection; a replacement
listener must receive no credential. No bridge payload, renderer state, log,
error, or fixture snapshot may contain the raw pairing credential or unexpected
descriptor fields.

For probe, launch, stop, pairing, and tunnel setup, prove that bounded `ssh -G`
runs before password-capable work and that the destination process invokes
BiBCode's fixed `KnownHostsCommand` helper before user authentication. The
helper must compare OpenSSH's SHA-256 `%f`, emit no host-key entry, and leave
normal user/system `known_hosts` independently authoritative. Enrollment may
write the observed fingerprint only to its private one-use file. Mismatch must
abort before askpass/userauth; the later destination command marker is only the
secondary barrier that releases remote script stdin. A different policy-trusted
key between probe and command must close without running the script. Confirm
managed and `--no-startup-pairing` launches remain authenticated, expose no
startup credential, and can still create pairing through protected local
control.

Exercise known-key success, first-seen/unknown key, changed or revoked key,
saved-fingerprint mismatch, user cancellation at the OpenSSH prompt, auth
failure, unreachable host, tunnel startup failure, non-loopback or nonnumeric
HTTP rejection, redirect and HTTP-proxy bypass rejection, oversize/malformed
descriptor and token replies, and remote pairing failure. Confirm there is no
`StrictHostKeyChecking=no`, private empty
`UserKnownHostsFile`, wildcard listener, or non-loopback plaintext HTTP escape.
Reject an effective custom `KnownHostsCommand`. Reject effective `SendEnv`
patterns that match `BIBCODE_SSH_*` or the password variable, while allowing
unrelated locale forwarding, and prove ambient internal variables are removed
before owned values are re-added. Exercise ProxyJump/ProxyCommand with key or
agent authentication; prove a password fallback is rejected before prompting
and no secret-bearing SSH process is spawned. A rejected invalid/changed-pin
disconnect must leave the published tunnel active. A managed POSIX launch must
fail closed when it has neither `ss` nor readable Linux procfs for port
selection, and when an installed/incompatible `ss` exits nonzero; do not record
that fixture as macOS support.
Desktop shutdown must leave no owned SSH, askpass, tunnel, or I/O task behind.
Until the lifecycle-fencing task in the current plan lands, record route-attempt
cancellation as unavailable rather than claiming that an in-flight native
bridge command was interrupted. Host-independent parsers and command fixtures
are compatibility evidence only; repeat Linux, macOS, and Windows OpenSSH
probe, consent, install, service, tunnel, descriptor, and recovery behavior on
the named native desktop.

### VCS coordination gates

When VCS status observation, mutation ownership, automatic fetch, or client
refresh scheduling changes, run the current focused owners before broad gates:

```sh
vp run check:contracts
vp test run apps/web/src/components/SourceControlPanel.test.tsx apps/web/src/components/files/FileBrowserPanel.test.tsx apps/web/src/components/GitActionsControl.test.tsx apps/web/src/components/Sidebar.test.tsx apps/web/src/components/ThreadStatusIndicators.test.tsx
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server git:: -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --lib git::broadcaster::tests::ref_poll_is_replaced_by_watcher_and_safety_status_reads -- --exact --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --lib terminal::manager::tests::retained_process_exit_callback_does_not_hold_terminal_publication -- --exact --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --lib production::runtime::tests::structured_terminal_process_exit_immediately_invalidates_status_under_watcher_fallback -- --exact --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --lib production::runtime::tests::provider_lifecycle_and_delivery_events_do_not_trigger_git_status_reads -- --exact --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test production_git_vcs_rpc -- --nocapture
vp test run packages/client-runtime/src/state/vcs.test.ts apps/web/src/components/GitActionsControl.test.tsx
```

On non-Windows hosts, replace the MSVC launcher with the equivalent direct
Cargo invocation. Run the production RPC file once with its default harness and
record the complete pass/fail matrix. If it exposes a causal product failure,
isolate only that case. Do not repeatedly run the file, serialize it, or change
production deadlines to conceal load/order timeouts.

For the event-driven VCS boundary, retain separate evidence for:

- the paused-time idle regression: after the initial snapshot, 59 seconds starts
  no status or `symbolic-ref` Git process, and 60 seconds starts exactly one
  local safety read without `symbolic-ref`;
- native worktree content, index, `HEAD`, packed-ref, and nested-ref events;
- watcher setup failure, root loss, overflow, sticky fallback, final release,
  reattachment, and shutdown;
- one 125 ms trailing watcher read and one immediate structured-terminal read;
- reconnect plus hidden, reveal, focus, and Git-menu explicit catch-up; and
- execution-host routing for native, WSL-direct, and SSH/server workspaces.

Host-independent event-shape and routing tests are compatibility evidence, not
native evidence for another operating system or remote host. Record unavailable
Linux, macOS, WSL, or SSH execution separately instead of simulating it as run.

For an automatic-fetch default decision, measure a current-source server or
desktop runtime, never an installed application. Use a disposable scenario
with a recorded number of physical repositories, worktrees, and active
`subscribeVcsStatus` streams. After bootstrap work settles, verify the recorder
with a short probe, clear it, then leave the scenario idle for a real interval
of at least ten minutes. Count top-level Git launches attributed by exact root
PID and process-start identity, retain command lines when the platform exposes
them, and normalize launches per elapsed minute per physical repository. State
whether discovery, status/diff, and fetch could be distinguished; do not infer
an internal operation label that the evidence does not contain.

On Windows the maintained controller performs that complete scenario and the
production-Atom queue benchmark. The default command records a 600-second
window; the short command exercises the same build, fixture, identity, probe,
cleanup, parser, and queue paths without serving as threshold evidence:

```powershell
node scripts/measure-vcs-runtime.ts
node scripts/measure-vcs-runtime.ts --duration-ms 3000 --queue-warmups 2 --queue-samples 10
```

The controller prints its unique evidence directory and retains ready, raw Git
launch, parsed Git summary, queue summary, server log, and aggregate summary
files there. Its example build overrides inherited Cargo target configuration
with an isolated target inside that directory and consumes Cargo
`compiler-artifact` JSON to launch those exact executable paths, including a
configured target-triple directory. Pass `--output-dir` only with a new path;
the controller refuses to
overwrite an existing evidence directory. Every success or failure requests a
graceful stop after one atomic Windows snapshot binds PID, parent PID, decimal
FILETIME, and executable. Both graceful and timeout cleanup capture/revalidate
the exact child tree, terminate verified descendants leaf-first and the owned
server handle last when required, await the server, and reject survivors.

Measure foreground queue delay separately through the actual production Atom
commands. Hold a real `vcs.refreshStatus` command active, schedule a same-key
mutation command, and record from scheduling immediately before the command run
to the mutation RPC execution start. Warm the harness, collect at least 100
measured samples, report the sample count and percentile method, and compute
p95 from the sorted measured values. A synthetic scheduler without production
command wiring is not acceptance evidence.

The automatic-fetch default is 180 seconds. A future default change requires an
approved measurement gate; the current decision thresholds are more than 20
top-level Git processes per minute per physical repository or more than 250 ms
foreground mutation queue delay at p95. Update the contract/default codec, Rust
settings defaults and fallbacks, RPC fixtures, settings tests, and user-facing
reset/presentation together. Preserve live updates, bounded failure backoff,
and `0 = disabled`. Record machine-specific process counts, timings, paths, and
the decision only in the execution report.

### Worktree catalog native fleet evidence

When catalog fingerprint inputs, reuse timing, or inventory invalidation change,
run the ignored native fleet test explicitly:

```powershell
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --lib worktree_catalog::tests::fingerprint_focus_fleet_reconciles_every_five_minutes_for_thirty_minutes -- --ignored --exact --nocapture
```

The test uses ten disposable real Git repositories, the production filesystem
fingerprint reader, and production Git inventory. It executes 18,000 Focus
refreshes over 30 minutes of paused policy time, checks every five-minute real
inventory boundary, and then proves real changed and Unknown fingerprint inputs
scan immediately. Record the native runtime and inventory counts in the
execution report; the test is ignored so this several-minute evidence workload
does not inflate ordinary server suites.

### File Manager index benchmark gate

When File Manager index phases or eager ignored-directory traversal change,
run the current-source, test-owned native Windows benchmark from the repository
root. Clear any smoke-sample override so the acceptance run collects exactly 30
cold builds and 30 immediate warm hits:

```powershell
Remove-Item Env:BIBCODE_FILE_INDEX_BENCHMARK_SAMPLES -ErrorAction SilentlyContinue
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --lib workspace::rpc::tests::benchmark_file_manager_index_phases -- --ignored --exact --nocapture
```

The ignored test creates one unique disposable real-Git repository and completes
fixture creation and Git setup before sampling. Before every cold request it
invalidates the cached root outside the measured build; each warm request follows
the completed cold request without setup or invalidation. Every cold sample must
assert exactly
`cache_wait(miss) -> git_snapshot(build) -> ignored_walk(build) ->
directory_walk(build) -> cache_build(built)`. Every warm sample must assert only
`cache_hit(hit)`, with the physical scan count unchanged; this is the acceptance
assertion that a warm hit started zero Git work.

The output must retain the raw millisecond arrays for `cache_build`,
`git_snapshot`, `ignored_walk`, `directory_walk`, and `cache_hit`, plus
`filesystem_walk` when a fallback fixture makes it applicable. Compute p50 and
p95 with sorted nearest rank at zero-based index
`ceil(sample_count * percentile / 100) - 1`; for 30 samples the p50 index is 14
and the p95 index is 28.

Record enough fixture metadata to reproduce and reconcile the returned entry
count: tracked workload files, tracked control files, ordinary untracked files,
ordinary directory rows, ignored files, ignored directory rows, empty directory
rows, total entries, and ignored entries. Record the host model, OS/build and
architecture, CPU core/logical-processor counts, physical memory, Rust/Cargo
versions, and Git version.

Apply the lazy-loading gate literally: a separately reviewed follow-up is
required when `ignored_walk` p95 is greater than 50% of `cache_build` p95 **OR**
greater than 500 ms. Otherwise record that lazy loading remains deferred; do not
change eager tree behavior as part of the measurement task. Machine-specific
fixture paths, raw arrays, phase timings, host details, ratios, and the gate
decision belong only in the execution report, never in this living runbook.

The two `git ls-files` reads use a workspace-index-specific ten-second
post-spawn execution bound. A bound change must preserve external cancellation,
output limits, sibling settlement, and bounded filesystem fallback. Verify a
slow successful pair inside the bound and timeout fallback beyond it with:

```powershell
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --lib workspace::search::tests::git_snapshot_accepts_slow_success_inside_bound_and_falls_back_beyond_it -- --exact --nocapture
```

Then run `workspace_rpc` twice at its default harness width. Isolate the known
watcher burst-coalescing assertion if it fails, but do not serialize the file,
weaken exact Git classification, or widen the shared Git runner.

## Workspace and static gates

Run broad owners sequentially so one Cargo process owns the shared build
directory at a time:

```sh
vp run test
cargo test --workspace -j 2 -- --test-threads=2
vp check
vp run typecheck
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
git diff --check
```

Use the repository's Windows/MSVC launcher when required by the native Windows
page. The `-j 2` option bounds Cargo compilation jobs. The
`--test-threads=2` harness option bounds concurrent tests within each Rust test
binary; it does not serialize distinct test binaries. Do not add
`--test-threads=1`, broad locks, sleeps, yields, or larger production deadlines
to make a loaded suite pass.

For each command record the exact invocation, exit code, duration, test totals,
warnings, cleanup diagnostics, and commands skipped after a failure. A broad
suite does not replace focused evidence.

## Native package contract

Build through current repository scripts. Discover the artifact and executable
from current package output and metadata rather than assuming a filename.
Confirm:

- package version and architecture;
- executable existence and permission;
- native package metadata and bundle identity;
- the artifact came from the tested worktree/revision; and
- signing, notarization, or Authenticode state without overstating unavailable
  credentials.

Build packaged desktop E2E through:

```sh
vp run test:ui:desktop:build
vp run test:ui:desktop
```

Set only the native platform value documented by the selected platform page.
After the build, set `BIBCODE_E2E_APP_PATH` to the exact worktree-built
application as documented by the selected platform page. Never use an installed
BiBCode application as evidence for the worktree build.

## Disposable external-worktree scenario

Create a unique temporary Git repository outside BiBCode-managed worktree and
user project locations. Configure identity locally, create an initial commit,
then create two or more worktrees with native `git worktree add`.

Include platform-relevant path aliases and at least one path with spaces. Record
Git's worktree paths and the host's physical/canonical identities. In the
packaged application:

1. add the repository as a project;
2. add its primary path and one linked-worktree path again, confirm both return
   the existing project/Main, and confirm no duplicate project appears;
3. observe manually created worktrees in **Discovered worktrees**;
4. verify the parent is grouped once and full paths remain accessible;
5. adopt one candidate and exercise **Add all** only on disposable candidates;
6. verify **Keep hidden** does not delete the Git worktree;
7. present the same physical worktree through its platform alias and confirm no
   duplicate owner/catalog entry appears;
8. restart the exact package and confirm identity/adoption persists; and
9. prove every external worktree still exists on disk.

Do not run destructive worktree scenarios against a user repository.

## Packaged visual validation

Use Codex Computer Use, not Orca, to operate the exact packaged executable.
Before launch, prove no conflicting BiBCode instance is running. Use disposable
application data and platform-specific renderer isolation without overwriting a
user profile.

Capture original-resolution screenshots at normal and minimum supported window
sizes. Cover relevant:

- Environment -> Project -> Main/thread hierarchy and Add Project duplicate
  disposition, with no left-panel settings/information tabs;
- provider settings and provider/terminal action menus;
- discovered and adopted external worktrees;
- Create Worktree exact local and remote ref selection: the exact value appears
  once, the derived name remains correct, and a remote-to-local race succeeds
  without duplicate branch creation;
- thread creation, switching, persistence, and streaming;
- terminal input/output and panel switching;
- Files tree nesting, mutations, and moves: one row per directory with its own
  expand arrow rather than merged directory chains, **New File…** creating the
  entry in the clicked nested folder while expanded folders stay expanded, a
  drag-move onto a folder row and onto the tree root, and a refused move (a name
  the target already holds) reported as an error with the tree resynced;
- Files picking up a file created in the workspace by another tool while the
  packaged application stays open, both on its own within seconds and
  immediately via **Refresh**; while a controlled rescan is pending, verify the
  visible **Refreshing…** state and repeated-request coalescing; on Windows,
  cover a WSL-hosted workspace as well as a native one, because
  directory-timestamp fidelity differs across that boundary;
- Activity subagents and background tasks, including elapsed time and keyboard
  navigation;
- responsive menus, overlays, narrow panels, and focus states; and
- loaded interaction without stale ownership, duplicate events, or runaway
  process growth.

The default packaged suite runs all of its spec files in one embedded-driver
session, resets client connection state before every test, and disables
WebDriver command retries. Treat reporter hook errors, retries, and timeouts as
test failures even when the individual scenarios are reported as passing.

At final packaged shutdown, inspect the raw worker and server logs. Provider and
terminal owners, operational logs, orchestration, and the SQLite worker must all
close without a retry, timeout, or dependency on stale cloned handles.

For every screenshot record the absolute evidence path, UI state, and review
finding. Inspect the full image and focused crops for clipping, overflow,
spacing, truncation, contrast, icon/text alignment, focus rings, tooltip
placement, disabled states, stale labels, and unintended movement. Keep
diagnostic frames separate from acceptance evidence.

Authentication-dependent scenarios must be reported as unavailable when the
native host has no suitable credentials. Never copy secrets into evidence.

## Non-native compatibility audit

Review shared and platform-gated code for every supported non-native host. Run
host-independent source-inclusion, contract, fixture, and cross-target checks
where they are supported. Confirm a native fix does not introduce:

- foreign path normalization or separators in shared code;
- an unsupported platform API in an unguarded module;
- platform-global environment or CWD mutation;
- deleted remote functionality when presentation alone is hidden;
- changed provider visibility outside the current product contract;
- lost process admission, cancellation, kill, wait, reap, or peer isolation;
- test serialization or timing workarounds; or
- dependency, lockfile, generated, or vendored-subtree drift.

If an SDK, linker, signing identity, or system service is unavailable, report
the exact limitation. Do not claim the non-native host passed.

## Failure classification and repair

On the first distinct failure:

1. stop the broad run and preserve its exact output;
2. reproduce once with the smallest relevant command;
3. classify it as product, test fixture, package/build, or environment;
4. trace the owning state and lifecycle boundary;
5. form a falsifiable hypothesis;
6. add a deterministic behavioral RED before a real repair;
7. implement the smallest coherent fix while preserving every platform;
8. rerun focused tests at relevant concurrency widths;
9. rerun affected package, static, native package, and visual gates in
   proportion to the boundary; and
10. update living architecture and these runbooks when their contract changes.

Do not repair a tested latency contract with sleeps, yields, broad
serialization, timeout widening, global locks, global process mutation, retry
loops that hide the failure, or weakened assertions. Distinguish honest
load-sensitive contract failures from environment starvation with positive
owner/readiness/cleanup evidence.

An integration test whose contract is ownership, output, or cleanup rather than
product latency may use one fixed, absolute, test-only observation deadline.
That deadline must bound the complete test owner, retain positive
readiness/output/reap assertions, and leave both the production deadline and a
dedicated production-deadline regression unchanged. Do not extend a deadline
that is itself the behavior under test.

## Cleanup

Resolve exact ownership before any destructive action. Stop only processes
launched by the run, using PID plus executable, creation/start identity, and
fixture/worktree association where available. Unmount only test-owned package
mounts. Remove only exact disposable repositories, worktrees, profiles,
artifact directories, and temporary roots created by the run.

Capture before/after process and temporary-root snapshots. Report pre-existing
survivors without killing or deleting them. Prove no scoped desktop, server,
provider, terminal, WebDriver, package, or fixture process remains.

## Final Git audit

Run:

```sh
git diff --check
git status --short
git log --oneline -10
```

Review the complete diff for unrelated edits, debug output, generated files,
dependency/lockfile drift, vendored changes, platform leaks, and missing living
documentation. Re-sync CodeGraph when source changed and it is usable under
`AGENTS.md`.

Do not push, merge, open a pull request, or publish an artifact unless the
current request explicitly authorizes it.

## Reporting

Copy [the execution report template](./execution-report-template.md). Lead with
one result classification and keep native, compatibility, and unavailable
evidence separate. Do not claim completion from partial output or prior runs.
