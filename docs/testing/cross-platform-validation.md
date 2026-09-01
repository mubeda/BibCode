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
vp test run packages/contracts/src/gitManager.test.ts packages/contracts/src/environment.test.ts apps/web/src/gitManagerStore.test.ts apps/web/src/components/gitManager scripts/privacy-contract.test.ts
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server git:: -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --lib git::manager:: -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --lib git::broadcaster::tests::ref_poll_is_replaced_by_watcher_and_safety_status_reads -- --exact --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --lib terminal::manager::tests::retained_process_exit_callback_does_not_hold_terminal_publication -- --exact --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --lib production::runtime::tests::structured_terminal_process_exit_immediately_invalidates_status_under_watcher_fallback -- --exact --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --lib production::runtime::tests::provider_lifecycle_and_delivery_events_do_not_trigger_git_status_reads -- --exact --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test production_git_vcs_rpc -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test git_manager_reads -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test git_manager_commit -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test production_git_manager_rpc -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test git_rpc -- --nocapture
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

For the Git Manager boundary, retain separate evidence for tip-pinned paging
and generation splicing; the shared project-then-repository lock rejecting a
competing Git Manager or catalog mutation with `operation-in-flight`;
server-authored blocked copy rendered unchanged; stream cancellation reaching
the Git child; and one explicit provider refresh after an idle interval that
produced no provider process or browser network request.

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

## Git Manager validation scenario

Run this scenario only against the exact packaged application and disposable
repositories. Destructive Git Manager scenarios must never run against a user
repository. Record the resulting paths, revisions, screenshots, command output,
and timings in the execution report, not in this runbook.

### Disposable Git Manager fixture

Run the following in a POSIX-compatible shell with Git and Node.js available.
On Windows, use Git Bash so the same fixture recipe applies. It creates one
fixture family in the operating system's temporary area: a primary repository,
two independent project clones for cache and isolation checks, one linked
worktree whose path contains a space, and a bare `origin`. The configured
`origin` looks like a supported provider remote so the explicit provider pane
is reachable, while repository Git traffic is rewritten locally to the bare
repository and never needs a network or real forge.

```sh
set -eu

GIT_MANAGER_FIXTURE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/bibcode-git-manager.XXXXXX")"
GIT_MANAGER_FIXTURE_REMOTE="https://github.com/bibcode-validation/git-manager-fixture.git"
GIT_MANAGER_FIXTURE_ORIGIN_URL="$(node -e \
  'process.stdout.write(require("node:url").pathToFileURL(process.argv[1]).href)' \
  "$GIT_MANAGER_FIXTURE_ROOT/origin.git")"
export GIT_MANAGER_FIXTURE_ROOT GIT_MANAGER_FIXTURE_REMOTE

git init --bare --quiet "$GIT_MANAGER_FIXTURE_ROOT/origin.git"
git init --quiet -b main "$GIT_MANAGER_FIXTURE_ROOT/main"
git -C "$GIT_MANAGER_FIXTURE_ROOT/main" config user.name \
  "BiBCode Git Manager Fixture"
git -C "$GIT_MANAGER_FIXTURE_ROOT/main" config user.email \
  "git-manager-fixture@example.test"
git -C "$GIT_MANAGER_FIXTURE_ROOT/main" config \
  "url.$GIT_MANAGER_FIXTURE_ORIGIN_URL.insteadOf" "$GIT_MANAGER_FIXTURE_REMOTE"
git -C "$GIT_MANAGER_FIXTURE_ROOT/main" remote add origin \
  "$GIT_MANAGER_FIXTURE_REMOTE"

cd "$GIT_MANAGER_FIXTURE_ROOT/main"

write_fixture_png() {
  node - "$1" "$2" "$3" "$4" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const [output, redText, greenText, blueText] = process.argv.slice(2);
const red = Number(redText);
const green = Number(greenText);
const blue = Number(blueText);
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  const checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

const header = Buffer.alloc(13);
header.writeUInt32BE(2, 0);
header.writeUInt32BE(2, 4);
header[8] = 8;
header[9] = 6;
const row = [0, red, green, blue, 255, red, green, blue, 255];
const pixels = Buffer.from([...row, ...row]);
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", header),
  chunk("IDAT", zlib.deflateSync(pixels)),
  chunk("IEND", Buffer.alloc(0)),
]);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, png);
NODE
}

{
  printf '%s\n' "section one target"
  for line in 1 2 3 4 5 6 7 8 9 10; do
    printf 'section one stable %s\n' "$line"
  done
  printf '%s\n' "section two target"
  for line in 1 2 3 4 5 6 7 8 9 10; do
    printf 'section two stable %s\n' "$line"
  done
  printf '%s\n' "section three target"
  for line in 1 2 3 4 5 6 7 8 9 10; do
    printf 'section three stable %s\n' "$line"
  done
} > partial.txt
printf '%s\n' "main base" > conflict.txt
printf '%s\n' "tracked discard baseline" > discard.txt
printf '%s\n' "tracked stash baseline" > stash.txt
write_fixture_png images/modified.png 220 40 40
write_fixture_png images/deleted.png 40 180 80
git add .
git commit --quiet -m "fixture baseline"

fixture_commit=1
while [ "$fixture_commit" -le 105 ]; do
  printf 'history fixture %s\n' "$fixture_commit" >> history.txt
  git add history.txt
  git commit --quiet -m "history fixture $fixture_commit"
  fixture_commit=$((fixture_commit + 1))
done

write_fixture_png images/modified.png 40 90 220
write_fixture_png images/added.png 220 180 40
rm -- images/deleted.png
git add -A images
git commit --quiet -m "image diff fixtures"
git tag -a fixture-annotated -m "annotated fixture tag"
git tag fixture-lightweight

git switch --quiet -c conflict-continue
printf '%s\n' "topic resolution" > conflict.txt
git add conflict.txt
git commit --quiet -m "conflicting topic for continue"
git switch --quiet main
git switch --quiet -c conflict-abort
printf '%s\n' "topic resolution" > conflict.txt
git add conflict.txt
git commit --quiet -m "conflicting topic for abort"
git switch --quiet main
printf '%s\n' "main resolution" > conflict.txt
git add conflict.txt
git commit --quiet -m "conflicting main change"

git switch --quiet -c merge-ready
printf '%s\n' "merge preview fixture" > merge-ready.txt
git add merge-ready.txt
git commit --quiet -m "merge-ready change"
git switch --quiet main
git switch --quiet -c cherry-source
printf '%s\n' "cherry-pick fixture" > cherry-source.txt
git add cherry-source.txt
git commit --quiet -m "cherry-pick source"
git switch --quiet main
git switch --quiet -c rewrite-sandbox
printf '%s\n' "rewrite first" > rewrite.txt
git add rewrite.txt
git commit --quiet -m "rewrite first"
printf '%s\n' "rewrite second" >> rewrite.txt
git add rewrite.txt
git commit --quiet -m "rewrite second"
git switch --quiet main

git push --quiet -u origin main
git -C "$GIT_MANAGER_FIXTURE_ROOT/origin.git" symbolic-ref HEAD refs/heads/main
git push --quiet origin fixture-annotated

git switch --quiet -c force-lease
git push --quiet -u origin force-lease
printf '%s\n' "local side" > force-local.txt
git add force-local.txt
git commit --quiet -m "force-with-lease local side"
git switch --quiet main
git switch --quiet -c push-ready
git push --quiet -u origin push-ready
printf '%s\n' "push-ready local change" > push-ready.txt
git add push-ready.txt
git commit --quiet -m "push-ready local commit"
git switch --quiet main
git switch --quiet -c publish-ready
printf '%s\n' "publish-ready local change" > publish-ready.txt
git add publish-ready.txt
git commit --quiet -m "publish-ready local commit"
git switch --quiet main

git clone --quiet "$GIT_MANAGER_FIXTURE_ORIGIN_URL" "$GIT_MANAGER_FIXTURE_ROOT/project-two"
git -C "$GIT_MANAGER_FIXTURE_ROOT/project-two" config user.name \
  "BiBCode Git Manager Fixture"
git -C "$GIT_MANAGER_FIXTURE_ROOT/project-two" config user.email \
  "git-manager-fixture@example.test"
git -C "$GIT_MANAGER_FIXTURE_ROOT/project-two" config \
  "url.$GIT_MANAGER_FIXTURE_ORIGIN_URL.insteadOf" "$GIT_MANAGER_FIXTURE_REMOTE"
git -C "$GIT_MANAGER_FIXTURE_ROOT/project-two" remote set-url origin \
  "$GIT_MANAGER_FIXTURE_REMOTE"
printf '%s\n' "remote main update" > "$GIT_MANAGER_FIXTURE_ROOT/project-two/remote-update.txt"
git -C "$GIT_MANAGER_FIXTURE_ROOT/project-two" add remote-update.txt
git -C "$GIT_MANAGER_FIXTURE_ROOT/project-two" commit --quiet -m "remote main update"
git -C "$GIT_MANAGER_FIXTURE_ROOT/project-two" push --quiet origin main
git -C "$GIT_MANAGER_FIXTURE_ROOT/project-two" switch --quiet force-lease
printf '%s\n' "remote side" > "$GIT_MANAGER_FIXTURE_ROOT/project-two/force-remote.txt"
git -C "$GIT_MANAGER_FIXTURE_ROOT/project-two" add force-remote.txt
git -C "$GIT_MANAGER_FIXTURE_ROOT/project-two" commit --quiet -m \
  "force-with-lease remote side"
git -C "$GIT_MANAGER_FIXTURE_ROOT/project-two" push --quiet origin force-lease
printf '%s\n' "project two only" > \
  "$GIT_MANAGER_FIXTURE_ROOT/project-two/project-two-only.txt"

git clone --quiet "$GIT_MANAGER_FIXTURE_ORIGIN_URL" "$GIT_MANAGER_FIXTURE_ROOT/project-three"
git -C "$GIT_MANAGER_FIXTURE_ROOT/project-three" config user.name \
  "BiBCode Git Manager Fixture"
git -C "$GIT_MANAGER_FIXTURE_ROOT/project-three" config user.email \
  "git-manager-fixture@example.test"
git -C "$GIT_MANAGER_FIXTURE_ROOT/project-three" config \
  "url.$GIT_MANAGER_FIXTURE_ORIGIN_URL.insteadOf" "$GIT_MANAGER_FIXTURE_REMOTE"
git -C "$GIT_MANAGER_FIXTURE_ROOT/project-three" remote set-url origin \
  "$GIT_MANAGER_FIXTURE_REMOTE"
printf '%s\n' "project three only" > \
  "$GIT_MANAGER_FIXTURE_ROOT/project-three/project-three-only.txt"

printf '%s\n' "stash one" >> stash.txt
git add stash.txt
git stash push --quiet -m "fixture stash one"
printf '%s\n' "stash two" >> stash.txt
git add stash.txt
git stash push --quiet -m "fixture stash two"

awk '
  $0 == "section one target" { print "section one changed"; next }
  $0 == "section two target" { print "section two changed"; next }
  $0 == "section three target" { print "section three changed"; next }
  { print }
' partial.txt > partial.txt.next
mv -- partial.txt.next partial.txt
printf '%s\n' "tracked discard changed" > discard.txt
printf '%s\n' "untracked discard fixture" > untracked-discard.txt

git worktree add --quiet -b occupied "$GIT_MANAGER_FIXTURE_ROOT/occupied worktree" main
git worktree list --porcelain
git rev-list --count --all
git stash list
git status --short
git for-each-ref --format='%(refname:short) %(objecttype)' refs/tags
git ls-remote --heads origin
```

The final checks must show more than 100 reachable commits, two stash entries,
the `occupied` linked worktree, both tag kinds, and the three intended working
tree changes. Keep the exported root available to the companion shell for the
procedure below. Add `main`, `project-two`, and `project-three` as three distinct
BiBCode projects; do not add `origin.git` or the linked worktree as separate
projects. Remove only this exact temporary root during the runbook's
[Cleanup](#cleanup).

### Local packaged-application procedure

The following are packaged-surface acceptance steps. Do not substitute a raw
RPC or command-line Git operation when a named Git Manager control is missing;
record that step as **FAIL**. The companion-shell commands below are exceptions
used only to create repository states that cannot be held while the application
starts.

1. Hover the primary fixture project's header and choose its **Git Manager**
   branch-icon button. Confirm the centre route is the project-scoped `/git`
   route, choosing the button again focuses the same manager, and reload returns
   to that route. Confirm every fresh open starts on **Main Checkout**, including
   after a prior linked-worktree selection and after reload.
2. Use the **Worktree** selector to choose `occupied worktree` and verify Changes,
   History, branch, and sync data retarget together. Return to **Main Checkout**,
   open the branch dropdown, and choose `occupied`. The row must name the owning
   worktree and say **Switch to worktree**; choosing it visibly redirects the
   selector instead of issuing checkout. Attempt rename and delete from that
   row and confirm the server-authored blocked presentation names the owning
   worktree path.
3. On **Main Checkout**, inspect the Changes rows for `partial.txt`,
   `discard.txt`, and `untracked-discard.txt`, then select each file and inspect
   its diff. While these changes are dirty, request a branch switch and confirm
   the dialog explains **Leave my changes** as an ordinary visible stash and
   **Bring my changes** as carrying the working tree; choose **Bring my changes**
   and then return to `main` the same way. In `partial.txt`, use the
   partial-staging gutter to toggle one line, one complete **Changed lines** run,
   and a dragged range; apply the selection and confirm only those lines move
   between **Unstaged** and **Staged**. Switch the diff between both areas,
   unstage a selected line, and exercise **Discard selected lines…** behind its
   confirmation. Then commit one included whole-file change, add another
   included whole-file change through **Amend Last Commit**, and confirm the
   commit is replaced rather than duplicated. Choose **Undo**, accept its
   explicit confirmation, and confirm the message and changes return without
   deleting files. Exercise whole-file discard and **Discard All**; tracked
   content must restore, an untracked path must use OS trash when available, and
   a trash failure must require the separate permanent-discard confirmation.
   Finish with a clean checkout.
4. Open **History**, scroll until the loaded list crosses the 100-commit page
   boundary, and select commits on both sides of that boundary. Confirm the
   selected commit's metadata, changed-file list, and per-file diff agree with
   Git. While the older page remains loaded, run this in the companion shell:

   ```sh
   printf '%s\n' "generation splice fixture" >> \
     "$GIT_MANAGER_FIXTURE_ROOT/occupied worktree/generation.txt"
   git -C "$GIT_MANAGER_FIXTURE_ROOT/occupied worktree" add generation.txt
   git -C "$GIT_MANAGER_FIXTURE_ROOT/occupied worktree" commit -m \
     "generation splice fixture"
   ```

   Confirm the new commit is spliced above the pinned history generation while
   the loaded older page, selection, and scroll context remain coherent, with no
   duplicate or missing rows.

5. From **Main Checkout**, create and check out a disposable branch, rename it,
   return to `main`, and delete the disposable branch through its confirmation.
   Confirm the dropdown's Default, Recent, and Other groups, current marker, and
   filtering stay current after each operation. Repeat the occupied-branch
   redirect from step 2 after these mutations to prove its owner was not lost.
6. On `main`, choose **Fetch origin** and confirm the remote-only main commit is
   discovered; choose **Pull origin** and confirm it arrives locally. Check out
   `push-ready` and choose **Push origin**; check out `publish-ready` and choose
   **Publish branch to origin**, confirming an upstream is established. Check
   out `force-lease` after the fetch and confirm its divergent state offers
   **Force push origin**. The confirmation must state `--force-with-lease` and
   the operation must stop if the lease is stale; no bare force-push path is
   acceptable. Return to `main`.
7. Open **Stashes** and confirm both native entries appear. Select each entry and
   each changed file to inspect its per-entry diff. Apply one entry and verify it
   remains listed, clean the applied changes, then pop that entry and verify it
   is removed; clean again and drop the other entry through its destructive
   confirmation. Open **Merge…**, select `merge-ready`, review the server-computed
   ahead/behind and mergeability preview, then merge and confirm the operation's
   started-to-finished presentation and resulting history.
8. Check out `conflict-continue` in the panel and create the deliberate rebase
   conflict from the companion shell:

   ```sh
   if git -C "$GIT_MANAGER_FIXTURE_ROOT/main" rebase main; then
     printf '%s\n' "expected rebase conflict did not occur" >&2
     exit 1
   fi
   git -C "$GIT_MANAGER_FIXTURE_ROOT/main" status --short
   ```

   Confirm the panel reports **Rebase underway**, presents `conflict.txt` as
   conflicted, and blocks unrelated mutations with the server-authored pending
   operation reason. Resolve the file in an editor, stage it, and choose
   **Continue**; the rebase must complete and the strip must clear. Then check out
   `conflict-abort`, create the same deliberate conflict, choose **Abort**, accept
   the confirmation, and confirm the pre-rebase branch and clean operation state
   are restored.

9. Check out `rewrite-sandbox`. In History, use the commit actions to
   cherry-pick the `cherry-pick source` commit, revert the resulting commit, and
   reset to the earlier `rewrite first` commit. Confirm cherry-pick and revert
   publish their operation state, and reset is unavailable until its explicit
   mode/effect confirmation is accepted. If the History action menu or any of
   these confirmations is absent, record **FAIL**; server primitives or an
   unmounted component are not packaged-application evidence.
10. Create an annotated tag from the toolbar, delete a disposable local tag
    through its confirmation, and push `fixture-lightweight` to `origin`; confirm
    the remote tag appears only after the explicit push. In History, select the
    `image diff fixtures` commit and inspect `images/modified.png`,
    `images/added.png`, and `images/deleted.png`. Exercise **2-up**, **Swipe**,
    **Onion-skin**, and **Difference** for the two-sided modification, then
    confirm the added file has no Before image and the deleted file has no After
    image. If delete or push is absent from the routed tag surface, record
    **FAIL** rather than substituting command-line Git.
11. Open **Show pull requests**, confirm the pane says provider data loads only
    on demand, and choose **Refresh** exactly once. Confirm one
    `gitManager.listPullRequests` refresh is sent through the environment's
    existing RPC connection. A configured provider may run separate pull-request
    and checks subcommands on the server; a missing CLI, credentials, or the
    fixture's intentionally nonexistent forge repository must produce the
    provider pane's explicit error or unavailable presentation without retrying
    in the background.
12. Validate the two-project view isolation before the cache limit. Give `main`
    and `project-two` different Changes filters, selected files, and active tabs,
    then alternate between their project-header buttons. Each project must
    restore only its own selection, filter, and tab and must never render paths,
    refs, stashes, history, or operation events from the other project.
13. Validate the two-entry least-recently-used view-state bound. Set distinctive
    state in `main`, then `project-two`, revisit `main` to make `project-two` least
    recent, and set different state in `project-three`. Revisit `main` and
    `project-three` and confirm both states survive. Finally revisit
    `project-two` and confirm its evicted selection, filter, and tab return to
    defaults. The panels must not remain mounted or subscribed while hidden.
14. Complete the [zero-telemetry observation](#zero-telemetry-observation) below
    and record it separately from the automated evidence under
    [VCS coordination gates](#vcs-coordination-gates).

### Zero-telemetry observation

This packaged-application check is mandatory; automated source and component
tests do not replace it.

1. Open browser developer tools, select **Network**, preserve the log, filter to
   third-party hosts, and clear the existing entries. Leave the Git Manager and
   its pull-request pane open and completely idle for at least ten minutes.
   Confirm the filtered log remains empty: no provider poll, avatar lookup,
   analytics, error report, feature flag, asset CDN, or other third-party
   request is permitted.
2. Keep the log and WebSocket-frame view open, then choose **Refresh** in the
   pull-request pane exactly once. Confirm in decoded frames or the server
   operation log that exactly one `gitManager.listPullRequests` provider-refresh
   invocation crosses the existing BiBCode connection and that no direct browser
   request targets the provider or any other third-party host. Server-side
   provider subcommands are permitted only as work owned by that one explicit
   invocation.
3. Render History author identities and every image-diff case, then run this in
   the developer-tools Console:

   ```js
   document
     .querySelector('section[aria-label="Repository history"]')
     ?.querySelectorAll('img[src^="http://"], img[src^="https://"]');
   ```

   Confirm the result is empty. Author identity must be local initials or a
   deterministic local identicon, and repository images must use local `data:`
   sources rather than an HTTP or HTTPS source.

The automated counterparts live in `scripts/privacy-contract.test.ts`,
`apps/web/src/components/gitManager/gitManagerTelemetry.test.tsx`, the inline
`mod telemetry` in `apps/server/src/git/manager/mod.rs`, and the source-text
tripwire in `apps/server/tests/git_rpc.rs`. Run them through
[VCS coordination gates](#vcs-coordination-gates); the manual pass above is the
evidence for the packaged application.

### Remote-hosted Git Manager run

Create the disposable fixture on the remote host, attach that environment by
following [Remote access](../user/remote-access.md), add the three fixture
projects to that environment, and repeat the complete local packaged-application
procedure and zero-telemetry observation against the remote-owned project. This
second run is required. Verify these remote deltas and no substitutes:

- the panel forwards the server-owned `workspaceRoot` as an opaque value, never
  resolves it through the client filesystem, and never substitutes a local
  path;
- deliberately disconnecting the environment renders **Git Manager
  Unavailable**, names the disconnection reason, and does not re-dial the
  environment;
- reconnecting the environment transparently re-attaches status and operation
  subscriptions, after which external repository changes and streamed operation
  events resume without reloading or reopening the panel; and
- an attached compatibility server whose descriptor omits one optional
  capability degrades only that surface. Prefer omitting
  `gitManagerPartialStaging`: the diff must remain readable, its line/hunk
  mutation controls must explain that partial staging is unsupported, and the
  rest of the panel must remain usable. Use an actual advertised descriptor,
  not a client-side edit; record the server build and descriptor in the report.

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
  nav row below Search, whose unread badge aggregates across environments;
  verify that it opens the full Agents view, selecting a row shows its live
  session in the right pane, the back arrow returns to the normal view, and the
  per-row jump-to-workspace action returns to the normal view and re-points the
  rail to that row's environment;
- provider settings and provider/terminal action menus;
- discovered and adopted external worktrees;
- Create Worktree exact local and remote ref selection: the exact value appears
  once, the derived name remains correct, and a remote-to-local race succeeds
  without duplicate branch creation;
- Git Manager opened from the project header, its worktree selector, a Changes
  list with the partial-staging gutter, History with a selected commit diff, the
  branch dropdown, fetch/pull/push/force-with-lease sync states, the native
  stash list, and an in-progress/conflicted repository state;
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
