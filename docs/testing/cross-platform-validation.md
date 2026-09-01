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

### Grant-driven remote sharing

When pairing-offer generation, grant reach metadata, desktop exposure, or
client revocation changes, validate the complete ceremony on every supported
native desktop: **Another device** widens before minting and shows one pairing
code as a deep link, browser URL, and QR code; **This computer only** and every
**Custom address** remain externally managed and never widen; a bind or firewall
failure mints nothing; and revoking the final native-managed **Another device**
offer or client returns the server to loopback. Confirm an off-host custom grant
remains visible in the off-host count but leaves authoritative desired exposure
loopback before and after session exchange.
Also verify browser/headless presentation remains read-only for exposure while
server-side mint and revocation stay available. Windows additionally owns the
program-scoped firewall evidence in its platform runbook; Linux and macOS do
not substitute a firewall assertion.

Capture visual evidence for all exposure-compensation outcomes, using a
test-owned server/profile and controlled failure injection where required:

- a mint failure after widening plus successful cleanup shows **The offer was
  not created. Remote access is confirmed local-only.**, and native state is
  local-only;
- a concurrent live grant shows that remote access remains enabled for another
  live access reason;
- a failed or blackholed cancellation still runs authoritative cleanup when
  this attempt widened: loopback authority narrows, while a possibly live offer
  or another live reason keeps the host wide;
- cancellation and authoritative cleanup that are both unconfirmed do not
  claim local-only restoration; and
- failed cleanup says topology could not be verified;
- consuming an off-host offer through the browser keeps exposure wide, and
  revoking that last browser session causes one local-only restart; and
- when a new off-host grant appears during narrowing, the one post-narrow read
  causes one compensating widen and the resulting offer remains reachable.
- a blackholed pairing-offer create response reaches the five-second attempt
  deadline, completes the bounded retry/cancel path, and reports either verified
  local-only cleanup or explicit cancellation/cleanup failure instead of
  remaining indefinitely in the generating state.
- a prior network-accessible native configuration with only legacy grants starts
  local-only and widens only after **Resume legacy remote access** is selected;
- unmounting the reconciler or switching topology before its first privileged
  apply cancels that work; after a local-only apply commits, unmount the view and
  prove the mandatory authoritative refetch and one needed compensating widen
  still complete.
- a failed background reconciliation retries at five-second intervals for at
  most three passes, then surfaces the warning toast instead of silently waiting
  for another authority revision.

Record the exposure mode, grant/session row, restart boundary, visible message,
and screenshot for each outcome. Do not use a later app restart as substitute
evidence for direct failed-mint cleanup.

Run the living-document contract plus the public WebSocket lifecycle and
transport-size tests from the repository root whenever this boundary changes:

```sh
vp test scripts/remote-architecture-contract.test.ts
vp test packages/contracts/src/rpc.test.ts packages/client-runtime/src/rpc/session.test.ts packages/client-runtime/src/connection/pairingAdd.test.ts packages/client-runtime/src/connection/registry.test.ts packages/client-runtime/src/state/remoteUpdates.test.ts apps/web/src/hostedPairing.test.ts apps/web/src/routes/pair.test.tsx apps/web/src/routes/settings.remote-servers.test.tsx apps/web/src/connection/databaseHealth.test.ts apps/web/src/components/ConnectionDatabaseRecoveryDialog.test.tsx apps/web/src/state/shareExposureReconciler.test.tsx apps/web/src/components/settings/remote-servers/shareOffer.test.ts
cargo test -p bibcode-server --test auth_http plain_websocket_connected_state_tracks_the_completed_upgrade_lifecycle -- --exact
cargo test -p bibcode-server --test auth_http plain_websocket_rejects_a_single_frame_larger_than_16_mib -- --exact
cargo test -p bibcode-server --test auth_http auth_routes_include_browser_cors_and_preflight_headers -- --exact
cargo test -p bibcode-server --test e2ee_ws oversized_pre_auth_websocket_message_is_rejected -- --exact
cargo test -p bibcode-server --test e2ee_ws preauth_peer_connection_cap_rejects_the_fifth_connection -- --exact
cargo test -p bibcode-server --test e2ee_ws preauth_loopback_forwarder_bypasses_public_peer_cap_but_keeps_burst_limit -- --exact
cargo test -p bibcode-server --test e2ee_ws established_capacity_is_partitioned_by_principal_and_released_on_close -- --exact
cargo test -p bibcode-server --test e2ee_ws inbound_plaintext_capacity_backpressures_by_principal_and_releases_on_close -- --exact
cargo test -p bibcode-server --test e2ee_ws incomplete_authenticated_message_closes_after_ten_seconds_without_progress -- --exact
cargo test -p bibcode-server --test e2ee_ws idle_authenticated_connection_has_no_reassembly_deadline -- --exact
cargo test -p bibcode-server --test e2ee_ws pairing_bootstrap_inside_the_channel_serves_get_config -- --exact
cargo test -p bibcode-server --test e2ee_ws off_host_pairing_requires_confirmation_even_without_a_client_flag -- --exact
cargo test -p bibcode-server --test e2ee_ws delivered_pairing_session_stays_pending_until_confirm_rpc -- --exact
cargo test -p bibcode-server --test e2ee_ws closing_before_confirm_revokes_the_pending_session -- --exact
cargo test -p bibcode-server --test e2ee_ws confirmed_pairing_session_survives_disconnect_and_restart_cleanup -- --exact
cargo test -p bibcode-server rpc::e2ee::tests::preauth_admission_partitions_slots_and_refills_peer_tokens --lib -- --exact
cargo test -p bibcode-server rpc::e2ee::tests::preauth_network_keys_canonicalize_ipv4_24_and_ipv6_64 --lib -- --exact
cargo test -p bibcode-server rpc::e2ee::tests::one_public_subnet_cannot_consume_more_than_half_the_global_pool --lib -- --exact
cargo test -p bibcode-server rpc::e2ee::tests::loopback_forwarder_can_use_global_capacity_without_the_public_peer_cap --lib -- --exact
cargo test -p bibcode-server rpc::e2ee::tests::missing_connect_info_uses_the_strict_unspecified_bucket --lib -- --exact
cargo test -p bibcode-server rpc::e2ee::tests::unrelated_public_networks_still_stop_at_the_global_cap --lib -- --exact
cargo test -p bibcode-server rpc::e2ee::tests::idle_preauth_peer_and_network_entries_are_pruned_without_exceeding_the_map_cap --lib -- --exact
cargo test -p bibcode-server rpc::e2ee::tests::inbound_empty_continuations_and_excessive_fragmentation_are_rejected --lib -- --exact
cargo test -p bibcode-server rpc::e2ee::tests::inbound_global_pressure_waits_for_capacity_instead_of_closing_the_victim --lib -- --exact
cargo test -p bibcode-server rpc::e2ee::tests::inbound_global_pressure_waits_past_five_seconds_and_resumes --lib -- --exact
cargo test -p bibcode-server rpc::e2ee::tests::incomplete_minted_session_delivery_is_compensated --lib -- --exact
cargo test -p bibcode-server rpc::e2ee::tests::outbound_logical_message_accepts_progress_across_record_deadlines --lib -- --exact
cargo test -p bibcode-server rpc::e2ee::tests::outbound_logical_message_rejects_a_stalled_record --lib -- --exact
cargo test -p bibcode-server rpc::e2ee::tests::outbound_logical_message_enforces_the_size_derived_total_deadline --lib -- --exact
cargo test -p bibcode-server rpc::e2ee::tests::completed_messages_retain_their_global_buffer_budget --lib -- --exact
cargo test -p bibcode-server rpc::session::tests::fit_first_budget_does_not_block_small_waiters_behind_an_aged_large_waiter --lib -- --exact
cargo test -p bibcode-server rpc::session::tests::cancelled_weighted_waiter_is_removed_and_capacity_is_refunded_once --lib -- --exact
cargo test -p bibcode-server rpc::session::tests::outbound_connection_wait_uses_the_same_absolute_deadline_as_process_wait --lib -- --exact
cargo test -p bibcode-server rpc::session::tests::two_tier_admission_does_not_hold_connection_bytes_while_process_bytes_are_blocked --lib -- --exact
cargo test -p bibcode-server rpc::session::tests::two_tier_admission_observes_release_between_probe_and_notify_poll --lib -- --exact
cargo test -p bibcode-server rpc::session::tests::inbound_guard_is_released_after_dispatch_not_handler_completion --lib -- --exact
cargo test -p bibcode-server rpc::session::tests::slow_socket_cannot_hide_more_than_one_large_response_in_the_session_queue --lib -- --exact
cargo test -p bibcode-server rpc::session::tests::slow_sockets_share_one_process_outbound_plaintext_budget --lib -- --exact
cargo test -p bibcode-server rpc::session::tests::response_larger_than_the_connection_budget_fails_the_session_closed --lib -- --exact
cargo test -p bibcode-server rpc::session::tests::byte_and_queue_admission_share_one_five_second_deadline --lib -- --exact
cargo test -p bibcode-server auth::service::tests::completed_pairing_offer_replays_and_cancels_after_restart --lib -- --exact
cargo test -p bibcode-server auth::service::tests::pending_pairing_offer_can_be_cancelled_after_restart --lib -- --exact
cargo test -p bibcode-server auth::service::tests::pending_pairing_offer_recovers_for_retry_after_restart --lib -- --exact
cargo test -p bibcode-server auth::service::tests::remote_offer_cancellation_converges_dormant_share_state_and_access_events --lib -- --exact
cargo test -p bibcode-server auth::service::tests::cancelled_guard_registration_releases_bookkeeping_while_persistence_is_queued --lib -- --exact
cargo test -p bibcode-server auth::service::tests::cancelled_pending_session_issuance_revokes_durable_commit_before_state_publication --lib -- --exact
cargo test -p bibcode-server auth::service::tests::pending_pairing_sweep_only_revokes_sessions_past_the_grace_window --lib -- --exact
cargo test -p bibcode-server --lib keeps_one_service_watcher -- --nocapture
cargo test -p bibcode-server auth::service::tests::cross_service_authentication_starts_watcher_for_the_cached_session --lib -- --exact
cargo test -p bibcode-server --test repositories pairing_offer_reservations_enforce_the_shared_ -- --nocapture
cargo test -p bibcode-server --test auth_http pairing_offer_authority_is_shared_across_simultaneously_live_servers -- --exact
cargo test -p bibcode-server --test auth_http remote_revocation_closes_an_acked_live_stream_before_later_events -- --exact
cargo test -p bibcode-server --test repositories pending_auth_sessions_confirm_by_id_and_startup_cleanup_is_selective -- --exact
cargo test -p bibcode-desktop firewall::tests --lib -- --nocapture
cargo test -p bibcode-desktop server_exposure::tests --lib -- --nocapture
cargo test -p bibcode-desktop bridge::tests::entering_wsl_only_recovers_native_exposure_before_switching_topology --lib -- --exact
cargo test -p bibcode-desktop bridge::tests::leaving_wsl_only_restarts_the_native_topology_explicitly_local_only --lib -- --exact
cargo test -p bibcode-desktop network_interfaces::tests::advertised_endpoint_classification_fixtures --lib -- --exact
cargo test -p bibcode-desktop network_interfaces::tests::public_default_route_is_advertised_but_never_default --lib -- --exact
cargo test -p bibcode-desktop backend::tests::lan_advertised_host_accepts_only_private_usable_ipv4_defaults --lib -- --exact
cargo test -p bibcode-desktop bridge::tests::local_only_discovery_surfaces_public_only_topology_as_unavailable --lib -- --exact
cargo test -p bibcode-desktop bridge::tests::local_only_discovery_marks_private_default_candidate_unavailable --lib -- --exact
cargo test -p bibcode-server auth::service::tests::custom_off_host_grants_remain_externally_managed_after_exchange --lib -- --exact
```

The pairing-add client suite must prove that the registered supervisor is the
only bearer proof—no second pinned socket—and that an ambiguous confirmation
observes `registry.stateChanges` for at most 30 interruptible seconds. Connected
state proves activation; blocked authentication, host identity, or storage
change rolls back local writes with `pairing-rejected`; an inconclusive window
leaves recovery with the supervisor. Local persistence and confirmation remain
the only uninterruptible segment.

### Direct E2EE interop gate

When direct pairing, host identity, `/ws-e2ee`, Noise framing, or client E2EE
session preparation changes, build the current Rust server and run the opt-in
TypeScript-to-Rust interop suite:

```sh
cargo build -p bibcode-server
cd packages/client-runtime
BIBCODE_E2EE_SERVER_BIN="$(git rev-parse --show-toplevel)/target/debug/bibcode" vp test run src/e2ee/serverInterop.test.ts
cd ../..
```

The suite must mint through the real pairing endpoint, pin the persisted host
key, authenticate the pending bootstrap channel, call `server.getConfig`, prove
the delivered bearer cannot reconnect before confirmation, confirm through
`auth.confirmPairing`, then reconnect with the active in-channel credential. It
must also reassemble a fragmented request and reject a bad pairing token.
Without `BIBCODE_E2EE_SERVER_BIN`, the same file intentionally reports skipped
so ordinary `vp test` does not depend on a prebuilt binary.

### Cross-container remote-server gate

When remote authentication, pairing, E2EE, share-state derivation, revocation,
or remote updates change, run the opt-in smoke test with the server and client
in distinct Linux containers. Build the current server first, verify Docker is
available, and use test-owned names so cleanup can be proven:

```sh
cargo build -p bibcode-server
docker version

cleanup_bibcode_remote_docker() {
  docker rm -f bibcode-remote-client 2>/dev/null || true
  docker rm -f bibcode-remote-server 2>/dev/null || true
  docker network rm bibcode-remote-stabilization 2>/dev/null || true
  docker volume rm bibcode-remote-stabilization-data 2>/dev/null || true
}
trap cleanup_bibcode_remote_docker EXIT INT TERM
docker network create bibcode-remote-stabilization
docker volume create bibcode-remote-stabilization-data

docker run -d --name bibcode-remote-server \
  --network bibcode-remote-stabilization \
  --security-opt label=disable \
  -e DEBIAN_FRONTEND=noninteractive \
  -v "$PWD/target/debug/bibcode:/usr/local/bin/bibcode:ro" \
  -v bibcode-remote-stabilization-data:/data \
  debian:trixie-slim \
  sh -c 'apt-get update >/dev/null && \
    apt-get install -y --no-install-recommends ca-certificates >/dev/null && \
    rm -rf /var/lib/apt/lists/* && \
    exec /usr/local/bin/bibcode --base-dir /data --host 0.0.0.0 --port 3773 serve'

for attempt in $(seq 1 120); do
  BIBCODE_DOCKER_PAIRING_JSON=$(docker exec bibcode-remote-server \
    /usr/local/bin/bibcode --base-dir /data pairing issue --json 2>/dev/null) && break
  sleep 0.25
done
test -n "${BIBCODE_DOCKER_PAIRING_JSON:-}"
BIBCODE_DOCKER_ADMIN_CREDENTIAL=$(node -e \
  'process.stdout.write(JSON.parse(process.argv[1]).credential)' \
  "$BIBCODE_DOCKER_PAIRING_JSON")

docker run --rm --name bibcode-remote-client \
  --network bibcode-remote-stabilization \
  --security-opt label=disable \
  -v "$PWD:/workspace:ro" -w /workspace \
  --tmpfs /workspace/node_modules/.vite-temp:rw,mode=1777 \
  -e BIBCODE_DOCKER_SERVER_URL=http://bibcode-remote-server:3773 \
  -e BIBCODE_DOCKER_ADMIN_CREDENTIAL="$BIBCODE_DOCKER_ADMIN_CREDENTIAL" \
  node:26-bookworm \
  ./node_modules/.bin/vp test packages/client-runtime/src/e2ee/dockerRemoteSmoke.test.ts

unset BIBCODE_DOCKER_PAIRING_JSON BIBCODE_DOCKER_ADMIN_CREDENTIAL
cleanup_bibcode_remote_docker
trap - EXIT INT TERM
```

The smoke test must cover descriptor negotiation, administrative token exchange,
an off-host pairing offer, pinned-host Noise NK authentication, pending
share-state retention, bootstrap-channel RPC, rejected bearer reconnect before
confirmation, idempotent `auth.confirmPairing`, and authenticated bearer
reconnect afterward. It sends a maximum-size Noise record and accepts continued
progress after more than five seconds, verifies updater status/check, a typed
manual-install failure, and a later healthy status result, and proves plain
`/ws` closes a 16 MiB-plus-one-byte frame. It also rejects a fifth silent
pre-auth socket from the real container peer, closes an authenticated connection
that exceeds the 2,048-record limit, retains exposure through a browser session,
actively closes a revoked E2EE session, and reaches final loopback share state.
Finally, it cancels an ambiguously delivered offer and proves a delayed retry
cannot recreate its grant.

One fixed-IP Node client cannot independently exercise the IPv4 `/24` fan-out
classifier, so subnet aggregation remains required focused Rust fixture/unit
evidence. The production headless container likewise has no injectable hung
desktop updater delegate or supervisor-acquisition seam; whole-update timeout and
fan-out-slot release remain required client-runtime tests, while Docker proves
result isolation. The containers disable SELinux process labeling because both
host bind mounts are read-only; this keeps the command portable on enforcing
hosts without relabeling the worktree. The client receives a narrow tmpfs for
Vite's generated config cache, so the repository itself stays read-only. It must
not spawn a host server, fall back to loopback, or print a pairing/session
credential.

After the run, all three commands below must print nothing:

```sh
docker ps -a --filter name=bibcode-remote- --format '{{.Names}}'
docker network ls --filter name=bibcode-remote-stabilization --format '{{.Name}}'
docker volume ls --filter name=bibcode-remote-stabilization-data --format '{{.Name}}'
```

Record image IDs, architecture, exact command results, and cleanup evidence in
an execution report. Never record or retain the temporary pairing credential.

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
cargo clean -p bibcode-server -p bibcode-desktop -p bibcode-updater-verifier
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
2. observe manually created worktrees in **Discovered worktrees**;
3. verify the parent is grouped once and full paths remain accessible;
4. adopt one candidate and exercise **Add all** only on disposable candidates;
5. verify **Keep hidden** does not delete the Git worktree;
6. present the same physical worktree through its platform alias and confirm no
   duplicate owner/catalog entry appears;
7. restart the exact package and confirm identity/adoption persists; and
8. prove every external worktree still exists on disk.

Do not run destructive worktree scenarios against a user repository.

## Packaged visual validation

Use Codex Computer Use to operate the exact packaged executable. Before launch,
prove no conflicting BiBCode instance is running. Use disposable application
data and platform-specific renderer isolation without overwriting a user
profile.

Capture original-resolution screenshots at normal and minimum supported window
sizes. Cover relevant:

- Add Project and environment presentation, including the left-panel environment
  rail (Local entry with its WSL sub-picker where applicable, saved-server
  entries with status dots, the add/manage affordances) and the environment
  context card with its ⋯ menu when a remote environment is selected—verifying
  that switching rail selection filters the projects panel without interrupting
  running sessions on other environments—and the cross-environment **Agents**
  section between Search and Projects, whose row selection re-points the rail to
  that row's environment;
- provider settings and provider/terminal action menus;
- discovered and adopted external worktrees;
- Create Worktree exact local and remote ref selection: the exact value appears
  once, the derived name remains correct, and a remote-to-local race succeeds
  without duplicate branch creation;
- thread creation, switching, persistence, and streaming;
- terminal input/output and panel switching, including reopening the global right panel after a
  sibling chat suppresses a previously active Activity surface;
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
