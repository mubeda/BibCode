# Remote Server Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A client can update a desktop-hosted (`interactive`) BiBCode server end to end: it sees the target version, confirms with the running-work counts, follows download, backup and restart, and learns for certain whether the host came back on the new version; a wide-bound (shared) host is protected like a loopback one, the host user is told who asked, and an AppImage update restart no longer leaves the old runtime running.

**Architecture:** Seven phases in dependency order.

- **Phase A (decision 1, R1).** The server builds its `UpdateMaintenance` owner for every desktop-mode runtime with a bootstrap token, whatever the bind, and exposes it on `ServerHandle`; HTTP routes still get it only when `maintenance_routes_enabled` holds. The desktop calls the owner in process for the primary and keeps the HTTP transport for WSL and other external backends, with the same bounds and error text.
- **Phase B (decision 5, R5).** On Linux, right before `app.restart()`, every descriptor above 2 is marked close-on-exec.
- **Phase C (decision 2).** Additive, decode-defaulted contract fields (`downloadPercent`, `targetVersion`, `installStage`, `installKind`, `bootId`, `remoteUpdateProgress`), the read method `updater.activeWork`, and a requester passed to `request_install` with one operational log line.
- **Phase D (decisions 2 and 4).** The desktop delegate maps percent, stage and target, and keeps the requester as `requestedBy` on `DesktopUpdateState`.
- **Phase E (decision 3).** A client-runtime coordinator runs one single-flight update per environment (at most two at once), follows the restart through `EnvironmentRegistry.stateChanges`, and decides success by `bootId` and version.
- **Phase F (UI).** Confirmation with counts, progress and failure labels on the card and the Settings row, the host notice, the browser-mode reload prompt, and **Show update steps** for manual hosts.
- **Phase G.** The CI-only `remote-install` smoke lane, living docs and runbooks, gates, live Playwright verification against a local fake host, and the two UI reviews.

**Tech Stack:** Rust (Axum 0.8, Tokio, Tauri 2.11 with `tauri-plugin-updater` 2.11, `libc` 0.2.189), TypeScript (Effect 4 beta Schema/RPC/Atom, `@effect/vitest`, Vite+), React 19, Playwright (live checks only).

**Spec:** [`docs/superpowers/specs/2026-09-24-remote-server-updates-design.md`](../specs/2026-09-24-remote-server-updates-design.md). The user approved it on 2026-09-24 with the recommended option on every ruling (R1 in-process protection, R2 host notice as specified, R3 sticky port as a small separate change, R4 host feed is the source of truth, R5 ship the AppImage relaunch fix). Read the spec before each phase; this plan argues from it. Where the spec's line numbers have drifted, the symbols named here are authoritative.

## Global Constraints

Copied from the spec (every task's requirements include these):

- Scope: "**In scope:** desktop-hosted (`interactive`) servers on Linux AppImage, macOS and Windows." "**Deferred:** headless self-update (`supervised`, research §5.4)." Headless servers stay manual.
- Host consent: "**allow and notify.** No prompt on the host, so unattended hosts still update; the host shows a notice naming the requesting device and logs the request."
- Prerequisite: the batch-1 badge states are already committed (`e75f6889`: **Checking…**, **Not checked yet**, **Can't reach updater** with **Retry**, busy polling). Build on `packages/client-runtime/src/state/remoteUpdates.ts`, `apps/web/src/state/remoteUpdates.ts` and `apps/web/src/components/settings/ServerUpdateBadge.tsx`; do not redo them.
- Decision 1 (a): "Build `UpdateMaintenance` in desktop mode with a bootstrap token whatever the bind, but give it to `AppState` only when `maintenance_routes_enabled` holds. HTTP then still answers 404 on a wildcard bind … keeping the loopback-or-WSL invariant." "No new listener, port or credential." Carry the handle on `BackendUpdateSnapshot`, "not on `BackendRunConfig` or `BackendUpdateEnvironment`, which derive `PartialEq`". Protection "calls it for the primary and keeps HTTP for WSL and other external backends, with the same bounds (45 s prepare, 250 ms progress, 10 s commit), error text and exit on cancel."
- Decision 2: "No new `RemoteUpdateState` literal: an older client's `Schema.Literals` decode would reject the snapshot. New string fields decode as plain strings and unknown values get a generic label. `packages/contracts` stays schema-only; the Rust mirrors live in `apps/server`."
- `bootId`: "Random for each `ServerRuntime` start." "It is never persisted and never gates storage identity."
- `updater.activeWork` → `{runningTurns, liveTerminals, queuedMessages}`: "Counts across all clients; scope `orchestration:read`." It is its own read method, never part of the status poll.
- Coordinator: "One single-flight run per environment in an Atom family, owned by the Atom runtime, so closing the dialog does not cancel it. At most two run at once (`MAX_CONCURRENT_REMOTE_UPDATE_CHECKS`); a third shows **Queued**. While a run is active, the card and row render its state, so batch-1's status query is not observed and does not poll alongside it."
- Coordinator timing: `server.getConfig` and `updater.status` "each capped at 10 s and the budget left"; `updater.install` 30 s; status polled every second; downloading 10 min; installing 2 min; after the disconnect "the restart budget is 3 min, with a supervisor retry at most every 5 s".
- Success: "`bootId ≠ bootIdBefore` **and** `serverVersion ≥ targetVersion` on a connected generation; without `remoteUpdateProgress`, the version alone, with no counts or stages." "Every connected generation that is not a success therefore reads `updater.status`, and `error` ends the run with its text." "A new boot on an older version with no error fails as 'restarted on v{old}'."
- Host notice: `updater.install` "moves to `register_unary_with_context`", looks up the caller's `ClientMetadata` "through `AuthService::list_clients`", reaches the host through the server→host delegate seam, "never `DesktopBridge`", and the host window receives it on the existing `desktop:update-state` event. Toast "once per install (a client joining a running install adds none)".
- Operational log: "one `tracing::info!` line in `server.log` … with label, OS, address, a short session-id prefix and the versions, plus a `warn` line on failure. No credentials."
- Decision 5 fix: "On Linux, right before `app.restart()`, mark every descriptor above 2 close-on-exec with `close_range(3, ~0U, CLOSE_RANGE_CLOEXEC)`, falling back to a `/proc/self/fd` loop."
- R3 (sticky port) is "a small separate change": **out of scope for this plan**. R4: do not adopt Orca's "a server behind the client is never current" rule; the version-drift line stays the only signal.
- Copy (exact strings; `{name}` is the saved server name, versions render with a leading `v`):
  - Action: **Update to v{latest}…**
  - Confirmation: "Updating {name} restarts BiBCode there. 2 running agents and 3 terminals will stop. Conversations and queued messages are kept, and agents continue when you send the next message." Variants: "Nothing is running on it now."; "Running agents and terminals on it will stop." (no counts); "This page reloads when {name} is back."; "v0.6.4 is newer than this app (v0.6.3). Update this app too." Buttons: **Update {name}** and **Cancel**. Always confirm.
  - Progress: **Downloading 42%**, **Backing up project data…** (from `installStage`), **Restarting…**, **Checking the new version…**, then **Updated to v0.6.4** with a toast.
  - Failures, as a toast and in the row, with **Retry**: "Couldn't update {name}: {host message}. Nothing was installed; it runs v0.6.2 again."; "{name} hasn't come back after the update. Check BiBCode on {name}; it may be on a different port."; "{name} restarted on v0.6.2 instead of v0.6.4."
  - Browser mode: "BiBCode on this server was updated to v0.6.4. Reload to use it." with **Reload**; it never reloads by itself.
  - Host toast: **Update requested from another device**, "BiBCode Desktop on MacIntel (192.168.1.34) is installing v0.6.4. BiBCode restarts when it's done.", and **Manage devices**.
  - Manual hosts: **Show update steps** replaces the card's **Check for updates**; steps follow `installKind` and the host's OS and architecture; each has **Copy**.

Repository requirements (AGENTS.md, controller brief):

- **Never run `scripts/seeded-desktop-upgrade-smoke.ts` locally.** Its cleanup runs `pkill -TERM -x bibcode-desktop`, which kills the user's app. Task 17 edits it and runs only its unit tests and `node --check`; CI runs the lane.
- **Implementers never commit.** Every task ends with "Stop: the controller runs a Codex review and asks the user before committing". No `git add`, `commit`, `stash`, `reset`, `checkout -- …`, `restore`, or `clean`. The only index use allowed is the temporary `GIT_INDEX_FILE` in the `check:contracts` block (Task 4), which never touches the real index.
- Focused tests first where a seam exists (watch red, then green). Run focused tests after each behavior change.
- Contract changes: schema + contract-shape fixtures + `vp run check:contracts` (temporary-index form, Task 4 Step 7).
- Gates: `vp check`, `vp run typecheck`, `cargo fmt --all --check`, `cargo clippy -p bibcode-server --all-targets -- -D warnings`, `cargo clippy -p bibcode-desktop --all-targets -- -D warnings`.
- `apps/web` React changes: review against `vercel-react-best-practices` **and** `UI.md`; report both, or mark one "not run".
- Living docs and `docs/testing/` runbooks change with the behavior (Task 18), or the report says they were "reviewed and remain accurate".
- **Live Playwright verification** of every UI state listed above (Task 20): isolated dev server (`BIBCODE_PORT_OFFSET=93`, its own `BIBCODE_HOME`), **never port 3773**, no real remote servers (a local fake host only).
- Never touch the user's `bibcode-desktop` on port 3773 or any process you did not start. Never print secrets (write `<REDACTED>`).
- Known host flakes (classify with a focused re-run or a base-vs-change comparison, never chase): `provider_terminal_supervisor` fails about once per full run at base; pipe-heavy fixture tests fail when `pipe-user-pages-soft` is exhausted; a `managed_endpoint` lib test can hang under heavy load.

## Coordination with concurrent work

Other agents edit this worktree at the same time. `git status --short` at planning time shows uncommitted edits in several files this plan must touch.

- **Connection-liveness plan** (`docs/superpowers/plans/2026-09-24-connection-liveness.md`):
  - Its Task 12 changes supervisor retry (jitter, idle ladder, `EnvironmentSelection`) in `connection/supervisor.ts` and `connection/registry.ts`. This plan **only consumes** `EnvironmentRegistry.stateChanges`, `retryNow`, and `SupervisorConnectionState.{phase,generation}`; it never edits supervisor or registry. The coordinator's own 5 s `retryNow` cadence deliberately ends any backoff or idle-ladder wait during the restart budget; confirm that still holds after liveness Task 12 lands (`retryNow` must still end the wait at once, which its plan keeps).
  - Its Task 15 changes automatic update-query revalidation in `ConnectTab.tsx` and `createEnvironmentQueryAtomFamily` in `packages/client-runtime/src/state/runtime.ts`. This plan does not edit `runtime.ts`. In `ConnectTab.tsx` it replaces the Update button and passes a `null` query while a run is active (Task 13); re-read the file and keep liveness's latch-preserving revalidation calls.
  - Its Task 16 edits `connection/presentation.ts`; this plan does not.
  - Both plans change `packages/contracts/fixtures/rpc-wire/manifest.json` and the counts in `apps/server/tests/rpc_wire.rs` (liveness adds a transport error fixture; this plan adds `updater.activeWork`). Whoever lands second recomputes the counts from the regenerated manifest.
- **Left-panel workspace-cards plan (track B)**: `apps/web/src/components/Sidebar.tsx`, `apps/web/src/components/sidebar/**` (including `EnvironmentContextCard.tsx`, `environmentContextCard.logic.ts`), `packages/contracts/src/ipc.ts`, and `docs/user/workspace-ui.md` are track B's. This plan must edit `Sidebar.tsx` (the `SidebarEnvironmentContextCard` function only), `EnvironmentContextCard.tsx`, `environmentContextCard.logic.ts` and `ipc.ts` (the `DesktopUpdateState` interface and schema only). **Open question 7** asks the controller to sequence these tasks (12, 14) after track B lands or approve targeted edits. Until then: make targeted `Edit`s to the named symbols, re-read each file immediately before editing, never reformat or rewrite.
- **SSH launch** (`apps/desktop/src-tauri/src/ssh.rs`, +695/−77 uncommitted by another agent): this plan does **not** edit it. SSH-launched servers are recognised client-side from `SshConnectionTarget`. The SSH steps copy (Task 15) names the launch script's state directory (`$HOME/.bibcode-ssh-launch/<key>/pid`) and runner (`bibcode` on the remote `PATH`); re-read `REMOTE_LAUNCH_SCRIPT` at implementation time and match its current paths.
- **Docs with uncommitted edits by others:** `docs/architecture/remote.md`, `overview.md`, `connection-runtime.md`, `docs/user/remote-access.md`, `docs/testing/{linux,macos,windows}-desktop.md`, `docs/operations/ci.md`. Targeted `Edit`s to your own paragraphs only.
- **Settings row files with uncommitted edits:** `ConnectTab.tsx`, `ConnectTab.test.tsx`, `connectPresentation.ts`, `connectPresentation.test.ts`. Targeted edits; keep the rename work.
- If a workspace-wide gate fails because of files outside this plan, record the output in the report and continue; do not edit those files.

## Spec conflicts and plan decisions

These are decisions the plan makes where the spec is silent; contradictions it cannot settle are under **Open questions for the controller** at the end.

1. **Error text across transports.** `decode_maintenance_response` embeds the HTTP status in its message. The in-process transport produces byte-identical text by mapping each `MaintenanceError` through one new `MaintenanceError::http_status_code()` (409 for `OperationMismatch`/`NoPreparedOperation`, 503 otherwise), which `http.rs::maintenance_error_response` also uses. Timeouts read "…: timed out after 45 seconds." / "…: timed out after 10 seconds." instead of reqwest's text. (Open question 2 asks for confirmation.)
2. **Integer percent.** `HostUpdaterStatus` and `RemoteUpdateSnapshot` derive `Eq`; an `f64` would break that. The Rust mirror carries `download_percent: Option<u8>` (floor, 0–100), still `number | null` on the wire, reported only while the host is `downloading`. (Open question 3.)
3. **`installKind` in Rust** is a `Copy` enum `RemoteUpdateInstallKind { Archive, SystemPackage, Unknown }` (kebab-case), so `RemoteUpdateSupport` stays `Copy` (the desktop copies it out of a mutex). TypeScript decodes it as `Schema.String` with default `"unknown"`.
4. **Coordinator file.** The coordinator core lives in a sibling module `packages/client-runtime/src/state/remoteUpdateCoordinator.ts` (pure Effect over a port, testable with `TestClock`); `remoteUpdates.ts` wires it into the Atom family as the spec describes.
5. **Progress labels** use only spec copy: the five preparation stages map to **Backing up project data…**, `stopping-backend` and `installing` map to **Restarting…**, and a null or unknown stage maps to the existing generic **Updating…**.
6. **Failures the spec does not word** (download over 10 min, install over 2 min, a rejected install request) reuse the host-failure sentence with a coordinator message: "Couldn't update {name}: the download did not finish in 10 minutes. Nothing was installed; it runs v{old} again." (Open question 8.)

## File structure

**Create**

| File | Responsibility |
| --- | --- |
| `apps/desktop/src-tauri/src/relaunch.rs` | Linux: mark every descriptor above 2 close-on-exec before `app.restart()` (decision 5). |
| `apps/server/examples/remote_update_fake_host.rs` | Live-check fake host: a real server with a scripted `RemoteUpdateDelegate`, restartable with a new version (Task 20 only). |
| `packages/client-runtime/src/state/remoteUpdateCoordinator.ts` | Pure coordinator: install, poll, follow the restart, decide success or failure (decision 3). |
| `packages/client-runtime/src/state/remoteUpdateCoordinator.test.ts` | Coordinator scenarios with a fake port and `TestClock`. |
| `apps/web/src/components/settings/remoteUpdatePresentation.ts` | Pure copy: action, confirmation, progress, failure, manual steps. |
| `apps/web/src/components/settings/remoteUpdatePresentation.test.ts` | Copy tests. |
| `apps/web/src/components/settings/UpdateServerDialog.tsx` | Confirmation dialog with `updater.activeWork` counts. |
| `apps/web/src/components/settings/UpdateServerDialog.test.tsx` | Dialog render tests. |
| `apps/web/src/components/settings/ManualUpdateStepsDialog.tsx` | **Show update steps** with **Copy**. |
| `apps/web/src/components/RemoteUpdateRequestNotifier.tsx` | Host toast from `DesktopUpdateState.requestedBy`. |
| `apps/web/src/components/RemoteUpdateRequestNotifier.test.tsx` | Toast-once tests. |
| `apps/web/src/components/ServerReloadPrompt.tsx` | Browser-mode lasting reload prompt. |
| `apps/web/src/serverReload.logic.ts` (+ `.test.ts`) | When the page's own server changed boot and version. |

**Modify**

| File | Tasks |
| --- | --- |
| `apps/server/src/maintenance.rs`, `apps/server/src/lifecycle.rs`, `apps/server/src/http.rs`, `apps/server/src/lib.rs` | 1, 5 |
| `apps/server/tests/production_maintenance.rs` | 1 |
| `apps/desktop/src-tauri/src/backend.rs`, `apps/desktop/src-tauri/src/updates.rs` | 2, 3, 8 |
| `apps/desktop/src-tauri/src/lib.rs` | 3 |
| `apps/server/src/remote_update.rs`, `apps/server/tests/remote_update_rpc.rs` | 4, 6, 7 |
| `apps/server/src/static_assets.rs`, `apps/server/src/config.rs`, `apps/server/tests/static_assets.rs` | 4 |
| `apps/server/src/config.rs` (`boot_id`), `apps/server/src/production/control.rs` | 5 |
| `apps/server/src/rpc/methods.rs`, `apps/server/src/auth/scope.rs`, `apps/server/src/production/remote_update_rpc.rs`, `apps/server/src/production/runtime.rs` (registration call only), `apps/server/src/persistence/repositories.rs`, `apps/server/src/production/server_terminal.rs`, `apps/server/src/terminal/manager.rs`, `apps/server/tests/rpc_wire.rs` | 6 |
| `apps/server/src/rpc/session.rs` | 7 |
| `apps/desktop/src-tauri/src/remote_update_delegate.rs` | 4, 7, 8 |
| `packages/contracts/src/remoteUpdate.ts` (+ test), `environment.ts` (+ test), `rpc.ts`, `ipc.ts` (+ test) | 4, 5, 6, 8 |
| `packages/contracts/scripts/export-rust-rpc-fixtures.ts` (+ test), `packages/contracts/src/rpcRustParity.test.ts`, `packages/contracts/fixtures/rpc-wire/**` (regenerated) | 4, 5, 6 |
| `packages/shared/src/testSupport.ts` and typed descriptor/snapshot literals the typechecker names | 4, 5 |
| `packages/client-runtime/src/state/remoteUpdates.ts` (+ test) | 10, 11 |
| `apps/web/src/state/remoteUpdates.ts` | 11 |
| `apps/web/src/components/settings/ServerUpdateBadge.tsx` (+ test) | 12, 15 |
| `apps/web/src/components/settings/remote-servers/ConnectTab.tsx` (+ test) | 13, 15 |
| `apps/web/src/components/sidebar/EnvironmentContextCard.tsx`, `environmentContextCard.logic.ts`, `apps/web/src/components/Sidebar.tsx` (`SidebarEnvironmentContextCard` only) | 14, 15 |
| `apps/web/src/tauriDesktopBridge.ts` (+ test) | 8 |
| `apps/web/src/AppRoot.tsx` | 16 |
| `scripts/seeded-desktop-upgrade-smoke.ts` (+ test), `.github/workflows/desktop-upgrade-smoke.yml` | 17 |
| Docs: `docs/architecture/{remote,overview,connection-runtime}.md`, `docs/user/remote-access.md`, `docs/user/server-installation.md`, `docs/operations/{release,ci,observability}.md`, `docs/testing/{linux,macos,windows}-desktop.md`, `docs/testing/cross-platform-validation.md`, `docs/reference/scripts.md` | 18 |

## Working conventions

- Run every command from the repository root `/work/workspaces/orca/BibCode/main-3` unless a step says otherwise.
- Scratch root: `S=/tmp/claude-1000/-work-workspaces-orca-BibCode-main-3/2c4f97f1-0ee1-4c37-b2bb-432255e2f351/scratchpad`. Live-check root: `LIVE=$S/remote-updates-live`. Logs, screenshots, profiles and reports go there, never into the repository.
- TypeScript focused tests: `vp test run <path>`. Rust: `cargo test -p <crate> --test <binary> -- <filter>` or `cargo test -p <crate> --lib <module path>`.
- Before editing any file in the coordination list above, re-read it; line numbers in this plan are orientation only.
- Keep a ledger in `$S/remote-updates-ledger.md`: one line per task with the commands run and their results.

---

## Phase A — Protecting a wide-bound host (decision 1, R1)

### Task 1: The server owns update maintenance whatever its bind

**Files:**
- Modify: `apps/server/src/maintenance.rs` (`MaintenanceError`, `maintenance_routes_enabled`, new `update_maintenance_owner_enabled`)
- Modify: `apps/server/src/http.rs` (`maintenance_error_response`)
- Modify: `apps/server/src/lifecycle.rs` (`ServerHandle`, `start_internal`)
- Modify: `apps/server/src/lib.rs` (`pub use maintenance::{…}`)
- Test: `apps/server/tests/production_maintenance.rs`

**Interfaces:**
- Consumes: `UpdateMaintenance::{prepare, commit, cancel, status, shutdown_after_response}` (already `pub`), `maintenance_routes_enabled(&ServerConfig)`.
- Produces:
  - `pub use maintenance::{MaintenanceError, UpdateMaintenance}` from `bibcode_server`.
  - `impl MaintenanceError { pub const fn http_status_code(&self) -> u16 }` — 409 for `OperationMismatch | NoPreparedOperation`, 503 for `AdmissionClosed | DrainTimeout { .. } | Preparation(_)`.
  - `pub(crate) fn update_maintenance_owner_enabled(config: &ServerConfig) -> bool` — `mode == Desktop && desktop_bootstrap_token.is_some()`.
  - `impl ServerHandle { #[must_use] pub fn update_maintenance(&self) -> Option<Arc<UpdateMaintenance>> }` — `Some` for every desktop-mode production runtime with a bootstrap token, `None` otherwise.

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/tests/production_maintenance.rs` (add `persistence::{BackupTrigger, StatePaths, inventory_verified_backups}` are already imported; add nothing else):

```rust
#[tokio::test]
async fn a_wide_bound_desktop_runtime_protects_in_process_while_http_maintenance_stays_hidden() {
    let root = tempfile::tempdir().expect("wide data root");
    disable_provider_processes(root.path());
    let bootstrap = "wide-bootstrap";
    let server = ServerRuntime::start(
        ServerConfig::new(root.path())
            .with_bind("0.0.0.0", 0)
            .with_desktop(bootstrap)
            .expect("desktop config"),
    )
    .await
    .expect("wide desktop runtime");
    let base = format!("http://127.0.0.1:{}", server.local_addr().port());
    let client = reqwest::Client::new();

    // The loopback-or-WSL HTTP invariant is unchanged.
    let hidden = client
        .post(format!("{base}{MAINTENANCE_UPDATE_PREPARE_PATH}"))
        .header(DESKTOP_MAINTENANCE_TOKEN_HEADER, bootstrap)
        .send()
        .await
        .expect("wide prepare response");
    assert_eq!(hidden.status(), StatusCode::NOT_FOUND);

    let maintenance = server
        .update_maintenance()
        .expect("a desktop runtime owns update maintenance whatever its bind");
    let prepared = timeout(Duration::from_secs(45), maintenance.prepare())
        .await
        .expect("in-process prepare stays within the 45 s bound")
        .expect("in-process prepare succeeds");
    assert_eq!(maintenance.status().await["phase"], "prepared");

    let paths = StatePaths::from_config(&desktop_config(root.path(), bootstrap));
    let inventory = inventory_verified_backups(&paths, prepared.storage_instance_id)
        .await
        .expect("verified backup inventory");
    assert_eq!(inventory.verified.len(), 1);
    assert_eq!(
        inventory.verified[0].manifest.trigger,
        BackupTrigger::PreUpdate
    );
    assert_eq!(
        inventory.verified[0].manifest.backup_id.to_string(),
        prepared.backup_id
    );

    let operation_id =
        uuid::Uuid::parse_str(&prepared.operation_id).expect("operation id is a UUID");
    maintenance
        .commit(operation_id)
        .await
        .expect("in-process commit succeeds");
    maintenance.shutdown_after_response();
    timeout(Duration::from_secs(2), server.wait_for_shutdown())
        .await
        .expect("commit exits the quiesced runtime");
    server.join().await.expect("wide runtime joins");
}

#[tokio::test]
async fn in_process_cancel_exits_and_a_mismatched_operation_changes_nothing() {
    let root = tempfile::tempdir().expect("cancel data root");
    disable_provider_processes(root.path());
    let server = ServerRuntime::start(
        ServerConfig::new(root.path())
            .with_bind("0.0.0.0", 0)
            .with_desktop("cancel-bootstrap")
            .expect("desktop config"),
    )
    .await
    .expect("wide desktop runtime");
    let maintenance = server.update_maintenance().expect("maintenance owner");
    let prepared = maintenance.prepare().await.expect("prepare");

    let mismatch = maintenance
        .cancel(uuid::Uuid::nil())
        .await
        .expect_err("a foreign operation id is refused");
    assert_eq!(mismatch.http_status_code(), 409);
    assert!(
        timeout(Duration::from_millis(50), server.wait_for_shutdown())
            .await
            .is_err(),
        "a mismatched operation must not alter maintenance state"
    );

    maintenance
        .cancel(uuid::Uuid::parse_str(&prepared.operation_id).expect("uuid"))
        .await
        .expect("cancel succeeds");
    maintenance.shutdown_after_response();
    timeout(Duration::from_secs(2), server.wait_for_shutdown())
        .await
        .expect("cancel exits instead of resuming");
    server.join().await.expect("join");
}

#[tokio::test]
async fn only_desktop_runtimes_with_a_bootstrap_token_own_update_maintenance() {
    let web_root = tempfile::tempdir().expect("web data root");
    let web = ServerRuntime::start(ServerConfig::new(web_root.path()).with_bind("127.0.0.1", 0))
        .await
        .expect("web runtime");
    assert!(web.update_maintenance().is_none());
    web.shutdown();
    web.join().await.expect("web join");

    let desktop_root = tempfile::tempdir().expect("desktop data root");
    disable_provider_processes(desktop_root.path());
    let desktop = ServerRuntime::start(desktop_config(desktop_root.path(), "loopback-bootstrap"))
        .await
        .expect("loopback desktop runtime");
    assert!(desktop.update_maintenance().is_some());
    desktop.shutdown();
    desktop.join().await.expect("desktop join");
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p bibcode-server --test production_maintenance -- in_process update_maintenance wide_bound`
Expected: compile error `no method named update_maintenance found for struct ServerHandle` and `no method named http_status_code`.

- [ ] **Step 3: Implement**

In `apps/server/src/maintenance.rs`, add below the `MaintenanceError` enum:

```rust
impl MaintenanceError {
    /// The HTTP status the maintenance routes answer with. The desktop's in-process
    /// transport uses the same table, so both transports produce the same error text.
    #[must_use]
    pub const fn http_status_code(&self) -> u16 {
        match self {
            Self::OperationMismatch | Self::NoPreparedOperation => 409,
            Self::AdmissionClosed | Self::DrainTimeout { .. } | Self::Preparation(_) => 503,
        }
    }
}
```

Replace `maintenance_routes_enabled` with an owner check plus the unchanged bind rule:

```rust
/// Every desktop-mode runtime with a bootstrap token owns an update-maintenance
/// coordinator, whatever its bind; the desktop calls it in process.
#[must_use]
pub(crate) fn update_maintenance_owner_enabled(config: &ServerConfig) -> bool {
    config.mode == ServerMode::Desktop && config.desktop_bootstrap_token.is_some()
}

/// The HTTP maintenance routes stay loopback-or-WSL only (overview "Desktop update
/// protection"); a wildcard native bind answers 404.
#[must_use]
pub(crate) fn maintenance_routes_enabled(config: &ServerConfig) -> bool {
    if !update_maintenance_owner_enabled(config) {
        return false;
    }
    let local_bind = config
        .host
        .parse::<std::net::IpAddr>()
        .is_ok_and(|address| address.is_loopback())
        || config.host.eq_ignore_ascii_case("localhost");
    let desktop_owned_wsl_bind =
        config.desktop_wsl_transport && matches!(config.host.as_str(), "0.0.0.0" | "::");
    local_bind || desktop_owned_wsl_bind
}
```

In `apps/server/src/http.rs::maintenance_error_response`, replace the `let status = match error { … };` block with:

```rust
    let status = StatusCode::from_u16(error.http_status_code())
        .unwrap_or(StatusCode::SERVICE_UNAVAILABLE);
```

In `apps/server/src/lifecycle.rs`:

1. Add `update_maintenance: Option<Arc<UpdateMaintenance>>,` to `struct ServerHandle` (after `_production_runtime`).
2. In `start_internal`, replace the `let update_maintenance = if maintenance_routes_enabled(&config) { … } else { None };` block with:

```rust
        let update_maintenance_owner = if update_maintenance_owner_enabled(&config) {
            production_runtime.as_ref().map(|runtime| {
                UpdateMaintenance::new(
                    admission_gate.clone(),
                    runtime.clone(),
                    database.clone(),
                    state_paths.clone(),
                    storage_instance_id,
                    store_classification,
                    config.server_version.clone(),
                    shutdown.clone(),
                    config.update_maintenance_drain_timeout,
                    config.update_maintenance_lease,
                )
            })
        } else {
            None
        };
        // HTTP gets the owner only on a loopback or desktop-owned WSL bind.
        let update_maintenance = if maintenance_routes_enabled(&config) {
            update_maintenance_owner.clone()
        } else {
            None
        };
```

3. Pass `update_maintenance: update_maintenance_owner,` in the returned `ServerHandle { … }` literal, and import `update_maintenance_owner_enabled` next to `maintenance_routes_enabled`.
4. Add to `impl ServerHandle`:

```rust
    /// The runtime's update-maintenance owner, for the desktop host's in-process
    /// protection. `Some` for every desktop-mode production runtime with a bootstrap
    /// token, whatever its bind; the HTTP routes may still be hidden.
    #[must_use]
    pub fn update_maintenance(&self) -> Option<Arc<UpdateMaintenance>> {
        self.update_maintenance.clone()
    }
```

In `apps/server/src/lib.rs`, extend the `pub use maintenance::{…}` list with `MaintenanceError, UpdateMaintenance`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p bibcode-server --test production_maintenance`
Expected: PASS, including the existing `maintenance_routes_are_hidden_outside_local_desktop_mode` (wide native bind still 404; WSL bind still routed) and the loopback HTTP prepare/commit/cancel tests.

- [ ] **Step 5: Lint the crate**

Run: `cargo fmt --all --check && cargo clippy -p bibcode-server --all-targets -- -D warnings`
Expected: no output from fmt; clippy clean.

- [ ] **Step 6: Stop: the controller runs a Codex review and asks the user before committing.**

### Task 2: The desktop protects its primary in process

**Files:**
- Modify: `apps/desktop/src-tauri/src/backend.rs` (`ManagedBackendRuntime`, `BackendUpdateSnapshot`, `snapshot_for_update`, `prepare_isolated_test_server_settings` visibility)
- Modify: `apps/desktop/src-tauri/src/updates.rs` (`PreparedBackend`, `prepare_backend_for_update`, `finish_backend_update`, `decode_maintenance_response`, `install_update`, `cancel_stop_and_restart`)
- Test: `apps/desktop/src-tauri/src/backend.rs` (`mod tests`), `apps/desktop/src-tauri/src/updates.rs` (`mod tests`)

**Interfaces:**
- Consumes: `bibcode_server::{UpdateMaintenance, MaintenanceError, PrepareForUpdateResult}`, `ServerHandle::update_maintenance()` (Task 1).
- Produces (all `pub(crate)` inside `bibcode-desktop`):
  - `backend.rs`: `#[derive(Clone)] pub(crate) struct InProcessUpdateMaintenance(pub(crate) Arc<bibcode_server::UpdateMaintenance>)` with a manual `Debug` (`finish_non_exhaustive`).
  - `BackendUpdateSnapshot` gains private `in_process_maintenance: BTreeMap<String, InProcessUpdateMaintenance>` and `pub(crate) fn in_process_maintenance(&self, environment_id: &str) -> Option<Arc<bibcode_server::UpdateMaintenance>>`.
  - `updates.rs`: `#[derive(Clone)] pub(crate) enum UpdateProtectionTransport { Http, InProcess(Arc<bibcode_server::UpdateMaintenance>) }`; `#[derive(Clone, Copy, Debug, Eq, PartialEq)] pub(crate) enum MaintenanceFinish { Commit, Cancel }`.
  - `pub(crate) async fn prepare_backend_for_update(config: &BackendRunConfig, transport: &UpdateProtectionTransport, on_progress: impl FnMut(UpdateMaintenanceProgress)) -> Result<PrepareForUpdateResult, String>`
  - `pub(crate) async fn finish_backend_update(config: &BackendRunConfig, transport: &UpdateProtectionTransport, finish: MaintenanceFinish, operation_id: &str) -> Result<(), String>`

- [ ] **Step 1: Write the failing snapshot test**

In `backend.rs` `mod tests`, next to `managed_runtime_stop_is_idempotent_and_waits_for_server_completion`:

```rust
    #[tokio::test]
    async fn update_snapshot_carries_the_in_process_maintenance_owner_of_a_running_runtime() {
        let temp = tempfile::tempdir().expect("tempdir should open");
        let (handle, config) = start_test_server(temp.path()).await;
        let backend = BackendSupervisor::new();
        let runtime = ManagedBackendRuntime::new(43, handle);
        let runtime_probe = runtime.clone();
        {
            let mut state = backend
                .state
                .lock()
                .expect("backend supervisor mutex poisoned");
            state.slots.insert(
                PRIMARY_LOCAL_ENVIRONMENT_ID.to_owned(),
                BackendSlotState {
                    launch_plan: Some(BackendLaunchPlan::local(
                        temp.path().to_path_buf(),
                        config.clone(),
                    )),
                    backend: Some(ManagedBackend::Runtime(Box::new(runtime))),
                    ..BackendSlotState::default()
                },
            );
        }

        let snapshot = backend.snapshot_for_update();
        assert!(
            snapshot
                .in_process_maintenance(PRIMARY_LOCAL_ENVIRONMENT_ID)
                .is_some(),
            "the primary's in-process owner must reach update protection"
        );
        assert!(snapshot.in_process_maintenance("wsl:Ubuntu").is_none());

        runtime_probe.request_stop();
        runtime_probe
            .wait_for_completion()
            .await
            .expect("runtime should join cleanly");
    }
```

- [ ] **Step 2: Write the failing transport tests**

In `backend.rs` `mod tests` (it already has `start_test_server`, `local_test_config`, `test_cli_data_root`):

```rust
    async fn start_wide_test_server(
        base_dir: &Path,
    ) -> (bibcode_server::ServerHandle, BackendRunConfig) {
        prepare_isolated_test_server_settings(base_dir)
            .expect("isolated desktop test settings should write");
        let mut config = local_test_config(0);
        config.bind_host = "0.0.0.0".to_string();
        let handle = ServerRuntime::start_with_ui_process_observer(
            server_config_for_launch(test_cli_data_root(base_dir), &config),
            Arc::new(UnavailableDesktopUiProcessObserver),
        )
        .await
        .expect("wide test server should start");
        config.port = handle.local_addr().port();
        (handle, config)
    }

    #[tokio::test]
    async fn a_wide_bound_primary_is_protected_in_process_and_exits_after_commit() {
        use crate::updates::{
            MaintenanceFinish, UpdateProtectionTransport, finish_backend_update,
            prepare_backend_for_update,
        };
        let temp = tempfile::tempdir().expect("tempdir should open");
        let (handle, config) = start_wide_test_server(temp.path()).await;

        let http = prepare_backend_for_update(&config, &UpdateProtectionTransport::Http, |_| {})
            .await
            .expect_err("the wide bind hides the HTTP maintenance API");
        assert_eq!(
            http,
            "Could not prepare Local for update protection (HTTP 404)."
        );

        let transport = UpdateProtectionTransport::InProcess(
            handle.update_maintenance().expect("in-process owner"),
        );
        let mut stages = Vec::new();
        let prepared = prepare_backend_for_update(&config, &transport, |progress| {
            stages.push(progress.stage);
        })
        .await
        .expect("in-process prepare succeeds on a wide bind");
        finish_backend_update(
            &config,
            &transport,
            MaintenanceFinish::Commit,
            &prepared.operation_id,
        )
        .await
        .expect("in-process commit succeeds");
        tokio::time::timeout(Duration::from_secs(2), handle.wait_for_shutdown())
            .await
            .expect("commit exits the backend like the HTTP path");
        handle.join().await.expect("backend joins");
    }

    #[tokio::test]
    async fn both_transports_report_the_same_text_for_a_mismatched_operation() {
        use crate::updates::{MaintenanceFinish, UpdateProtectionTransport, finish_backend_update};
        let loopback_root = tempfile::tempdir().expect("tempdir should open");
        let (loopback, loopback_config) = start_test_server(loopback_root.path()).await;
        let foreign = "00000000-0000-4000-8000-000000000000";

        let over_http = finish_backend_update(
            &loopback_config,
            &UpdateProtectionTransport::Http,
            MaintenanceFinish::Cancel,
            foreign,
        )
        .await
        .expect_err("no prepared operation over HTTP");
        let in_process = finish_backend_update(
            &loopback_config,
            &UpdateProtectionTransport::InProcess(
                loopback.update_maintenance().expect("in-process owner"),
            ),
            MaintenanceFinish::Cancel,
            foreign,
        )
        .await
        .expect_err("no prepared operation in process");
        assert_eq!(over_http, in_process);
        assert_eq!(
            in_process,
            "Update maintenance for Local failed with HTTP 409."
        );

        loopback.shutdown();
        loopback.join().await.expect("loopback joins");
    }
```

Make `prepare_isolated_test_server_settings` `pub(crate)` only if another module needs it; these tests live in `backend.rs`, so leave it private.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test -p bibcode-desktop --lib backend::tests::update_snapshot_carries backend::tests::a_wide_bound_primary backend::tests::both_transports`
Expected: compile errors for `in_process_maintenance`, `UpdateProtectionTransport`, `MaintenanceFinish`.

- [ ] **Step 4: Carry the owner from the runtime to the snapshot**

In `backend.rs`:

```rust
/// The in-process primary's update-maintenance owner. Kept off `BackendRunConfig`
/// and `BackendUpdateEnvironment`, which derive `PartialEq`.
#[derive(Clone)]
pub(crate) struct InProcessUpdateMaintenance(pub(crate) Arc<bibcode_server::UpdateMaintenance>);

impl std::fmt::Debug for InProcessUpdateMaintenance {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("InProcessUpdateMaintenance")
            .finish_non_exhaustive()
    }
}
```

- Add `update_maintenance: Option<InProcessUpdateMaintenance>,` to `ManagedBackendRuntime`. In `ManagedBackendRuntime::new`, read it **before** the handle moves into the spawned task: `let update_maintenance = handle.update_maintenance().map(InProcessUpdateMaintenance);` and store it in `Self { … }`. The manual `Debug` impl stays unchanged (`finish_non_exhaustive`).
- Add `in_process_maintenance: BTreeMap<String, InProcessUpdateMaintenance>,` to `BackendUpdateSnapshot`, and:

```rust
impl BackendUpdateSnapshot {
    pub(crate) fn in_process_maintenance(
        &self,
        environment_id: &str,
    ) -> Option<Arc<bibcode_server::UpdateMaintenance>> {
        self.in_process_maintenance
            .get(environment_id)
            .map(|owner| owner.0.clone())
    }
}
```

- In `snapshot_for_update`, inside the slot loop, after computing `environment_id`:

```rust
            if let Some(ManagedBackend::Runtime(runtime)) = &slot.backend
                && let Some(owner) = &runtime.update_maintenance
            {
                in_process_maintenance.insert(environment_id.clone(), owner.clone());
            }
```

with `let mut in_process_maintenance = BTreeMap::new();` before the loop and the field set in the returned literal. Update every other `BackendUpdateSnapshot { … }` literal the compiler names (tests) with `in_process_maintenance: BTreeMap::new()`.

- [ ] **Step 5: Add the transport to protection**

In `updates.rs`:

```rust
const UPDATE_PROTECTION_PREPARE_TIMEOUT: Duration = Duration::from_secs(45);
const UPDATE_PROTECTION_FINISH_TIMEOUT: Duration = Duration::from_secs(10);

/// How the host reaches one backend's update-maintenance owner. The in-process
/// primary is called directly, so protection also works while it is shared on a
/// wildcard bind; WSL and other external backends keep the loopback HTTP API.
#[derive(Clone)]
pub(crate) enum UpdateProtectionTransport {
    Http,
    InProcess(Arc<bibcode_server::UpdateMaintenance>),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum MaintenanceFinish {
    Commit,
    Cancel,
}

impl MaintenanceFinish {
    const fn path(self) -> &'static str {
        match self {
            Self::Commit => MAINTENANCE_UPDATE_COMMIT_PATH,
            Self::Cancel => MAINTENANCE_UPDATE_CANCEL_PATH,
        }
    }
}

fn maintenance_failure_text(
    config: &BackendRunConfig,
    operation: &str,
    status: u16,
    detail: Option<&str>,
) -> String {
    format!(
        "Could not {operation} {} for update protection (HTTP {status}).{}",
        config.label,
        detail
            .map(|detail| format!(" {}", bounded_maintenance_error_detail(detail)))
            .unwrap_or_default()
    )
}
```

- Rename today's `prepare_backend_for_update` body to `async fn prepare_backend_over_http(config, on_progress)` (unchanged except its 45 s timeout now reads `UPDATE_PROTECTION_PREPARE_TIMEOUT`), and make `decode_maintenance_response` build its error through `maintenance_failure_text(config, operation, status.as_u16(), detail.as_deref())` where `detail` is the decoded `message` (bounded inside the helper).
- New dispatcher and in-process path:

```rust
pub(crate) async fn prepare_backend_for_update(
    config: &BackendRunConfig,
    transport: &UpdateProtectionTransport,
    on_progress: impl FnMut(UpdateMaintenanceProgress),
) -> Result<PrepareForUpdateResult, String> {
    match transport {
        UpdateProtectionTransport::Http => prepare_backend_over_http(config, on_progress).await,
        UpdateProtectionTransport::InProcess(maintenance) => {
            prepare_backend_in_process(config, maintenance, on_progress).await
        }
    }
}

async fn prepare_backend_in_process(
    config: &BackendRunConfig,
    maintenance: &Arc<bibcode_server::UpdateMaintenance>,
    mut on_progress: impl FnMut(UpdateMaintenanceProgress),
) -> Result<PrepareForUpdateResult, String> {
    let prepare = tokio::time::timeout(UPDATE_PROTECTION_PREPARE_TIMEOUT, maintenance.prepare());
    tokio::pin!(prepare);
    let first_progress_poll = tokio::time::Instant::now() + UPDATE_PROTECTION_PROGRESS_INTERVAL;
    let mut progress_interval =
        tokio::time::interval_at(first_progress_poll, UPDATE_PROTECTION_PROGRESS_INTERVAL);
    progress_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            _ = progress_interval.tick() => {
                if let Ok(status) =
                    tokio::time::timeout(UPDATE_PROTECTION_STATUS_TIMEOUT, maintenance.status()).await
                    && let Ok(progress) = serde_json::from_value::<UpdateMaintenanceProgress>(status)
                    && progress.stage.is_some()
                {
                    on_progress(progress);
                }
            }
            result = &mut prepare => {
                return match result {
                    Err(_) => Err(format!(
                        "Could not prepare {} for update protection: timed out after 45 seconds.",
                        config.label
                    )),
                    Ok(Ok(prepared)) => Ok(prepared),
                    Ok(Err(error)) => Err(maintenance_failure_text(
                        config,
                        "prepare",
                        error.http_status_code(),
                        Some(&error.to_string()),
                    )),
                };
            }
        }
    }
}
```

- Replace `finish_backend_update(config, path, operation_id)` with:

```rust
pub(crate) async fn finish_backend_update(
    config: &BackendRunConfig,
    transport: &UpdateProtectionTransport,
    finish: MaintenanceFinish,
    operation_id: &str,
) -> Result<(), String> {
    match transport {
        UpdateProtectionTransport::Http => {
            finish_backend_update_over_http(config, finish.path(), operation_id).await
        }
        UpdateProtectionTransport::InProcess(maintenance) => {
            let failed = |status: u16| {
                format!(
                    "Update maintenance for {} failed with HTTP {status}.",
                    config.label
                )
            };
            // The HTTP route answers 409 for an unparsable id; keep the same text.
            let Ok(operation_id) = uuid::Uuid::parse_str(operation_id) else {
                return Err(failed(
                    bibcode_server::MaintenanceError::OperationMismatch.http_status_code(),
                ));
            };
            let outcome = match finish {
                MaintenanceFinish::Commit => {
                    tokio::time::timeout(UPDATE_PROTECTION_FINISH_TIMEOUT, maintenance.commit(operation_id)).await
                }
                MaintenanceFinish::Cancel => {
                    tokio::time::timeout(UPDATE_PROTECTION_FINISH_TIMEOUT, maintenance.cancel(operation_id)).await
                }
            };
            match outcome {
                Err(_) => Err(format!(
                    "Could not complete update maintenance for {}: timed out after 10 seconds.",
                    config.label
                )),
                Ok(Err(error)) => Err(failed(error.http_status_code())),
                Ok(Ok(())) => {
                    // Same as the HTTP route: the backend exits after commit or cancel.
                    maintenance.shutdown_after_response();
                    Ok(())
                }
            }
        }
    }
}
```

where `finish_backend_update_over_http` is today's function body, unchanged (it already uses `Duration::from_secs(10)`; switch it to `UPDATE_PROTECTION_FINISH_TIMEOUT`). (`uuid` is already a `bibcode-desktop` dependency.)

- In `install_update`, give `PreparedBackend` a `transport: UpdateProtectionTransport` field and choose it per environment:

```rust
                let transport = if environment.primary {
                    snapshot
                        .in_process_maintenance(&environment.environment_id)
                        .map_or(UpdateProtectionTransport::Http, UpdateProtectionTransport::InProcess)
                } else {
                    UpdateProtectionTransport::Http
                };
                match prepare_backend_for_update(&config, &transport, |progress| { … }).await {
                    Ok(result) => { …; prepared.push(PreparedBackend { config, transport, operation_id: result.operation_id }); }
                    …
                }
```

  The commit loop calls `finish_backend_update(&operation.config, &operation.transport, MaintenanceFinish::Commit, &operation.operation_id)`; `cancel_stop_and_restart` calls it with `MaintenanceFinish::Cancel`.
- Update the existing `prepare_polls_status_and_publishes_progress_before_completion` test call to `prepare_backend_for_update(&config, &UpdateProtectionTransport::Http, |update| progress.push(update))`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cargo test -p bibcode-desktop --lib backend::tests updates::tests`
Expected: PASS, including the three new tests and every existing update-protection test.

- [ ] **Step 7: Lint**

Run: `cargo fmt --all --check && cargo clippy -p bibcode-desktop --all-targets -- -D warnings`
Expected: clean.

- [ ] **Step 8: Stop: the controller runs a Codex review and asks the user before committing.**

## Phase B — The AppImage relaunch leaves no old runtime (decision 5, R5)

### Task 3: Mark inherited descriptors close-on-exec before relaunch

**Files:**
- Create: `apps/desktop/src-tauri/src/relaunch.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs` (`mod relaunch;`)
- Modify: `apps/desktop/src-tauri/src/updates.rs` (`install_update`, just before `app.restart()`)

**Interfaces:**
- Produces: `pub(crate) fn prepare_descriptors_for_relaunch()` — on Linux marks every descriptor ≥ 3 close-on-exec (`close_range(3, u32::MAX, CLOSE_RANGE_CLOEXEC)` through `libc::syscall(libc::SYS_close_range, …)`, falling back to a `/proc/self/fd` + `fcntl(F_SETFD)` loop on `ENOSYS`/`EINVAL`); a no-op elsewhere. Failures are logged with `tracing::warn!`, never returned: the process is exiting either way.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src-tauri/src/relaunch.rs` with only the test module first:

```rust
//! Keeps the Linux AppImage relaunch from inheriting the old runtime's descriptors.
//!
//! `app.restart()` spawns the new AppImage and exits. The child inherits every
//! descriptor without close-on-exec, including the old type-2 runtime's keep-alive
//! pipe, so the old FUSE mount, its daemon and the replaced AppImage stay alive until
//! BiBCode quits (spec decision 5). Only exec'd children are affected, and the
//! process is exiting.

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use std::os::fd::AsRawFd;
    use std::process::Command;

    fn has_cloexec(fd: libc::c_int) -> bool {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        assert_ne!(flags, -1, "F_GETFD failed");
        flags & libc::FD_CLOEXEC != 0
    }

    #[test]
    fn an_inherited_pipe_is_marked_close_on_exec_and_a_spawned_child_lacks_it() {
        let mut fds = [0 as libc::c_int; 2];
        // A plain pipe(2) has no close-on-exec, like the runtime's keep-alive pipe.
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        let (read_end, write_end) = (fds[0], fds[1]);
        assert!(!has_cloexec(read_end) && !has_cloexec(write_end));

        super::prepare_descriptors_for_relaunch();

        assert!(has_cloexec(read_end), "read end must be close-on-exec");
        assert!(has_cloexec(write_end), "write end must be close-on-exec");
        let stdin = std::io::stdin();
        assert!(!has_cloexec(stdin.as_raw_fd()), "stdio stays inheritable");

        let status = Command::new("sh")
            .arg("-c")
            .arg(format!("test -e /proc/self/fd/{write_end}"))
            .status()
            .expect("sh should spawn");
        assert!(!status.success(), "the child must not inherit the pipe");

        unsafe {
            libc::close(read_end);
            libc::close(write_end);
        }
    }
}
```

Add `mod relaunch;` to `apps/desktop/src-tauri/src/lib.rs` (alphabetically, between `preview` and `remote_update_delegate`).

The test marks every descriptor of the test process close-on-exec. That is harmless for the rest of the `bibcode-desktop --lib` suite (tokio's epoll and sockets are not inherited by design), but a later test that expects a child to inherit a descriptor would fail when it runs after this one in the same process; if such a test appears, run this one in its own process (`cargo test … -- --test-threads=1 relaunch::tests` or a `#[ignore]`d integration binary) rather than weakening the fix.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p bibcode-desktop --lib relaunch::tests`
Expected: compile error `cannot find function prepare_descriptors_for_relaunch in module super`.

- [ ] **Step 3: Implement**

Add above the test module in `relaunch.rs`:

```rust
/// Marks every descriptor above stderr close-on-exec before the updater relaunches
/// the application. A no-op outside Linux.
pub(crate) fn prepare_descriptors_for_relaunch() {
    #[cfg(target_os = "linux")]
    linux::mark_inherited_descriptors_close_on_exec();
}

#[cfg(target_os = "linux")]
mod linux {
    const FIRST_INHERITED_DESCRIPTOR: libc::c_uint = 3;

    pub(super) fn mark_inherited_descriptors_close_on_exec() {
        // close_range(2) needs Linux 5.11 for CLOSE_RANGE_CLOEXEC; call it through
        // syscall(2) so the AppImage build host's glibc version does not matter.
        let result = unsafe {
            libc::syscall(
                libc::SYS_close_range,
                FIRST_INHERITED_DESCRIPTOR,
                libc::c_uint::MAX,
                libc::CLOSE_RANGE_CLOEXEC,
            )
        };
        if result == 0 {
            return;
        }
        let error = std::io::Error::last_os_error();
        if !matches!(error.raw_os_error(), Some(libc::ENOSYS | libc::EINVAL)) {
            tracing::warn!(%error, "close_range could not mark descriptors close-on-exec");
        }
        mark_through_proc();
    }

    fn mark_through_proc() {
        let entries = match std::fs::read_dir("/proc/self/fd") {
            Ok(entries) => entries,
            Err(error) => {
                tracing::warn!(%error, "could not list descriptors before relaunch");
                return;
            }
        };
        // Collect first: the directory handle is itself a descriptor.
        let descriptors = entries
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().to_str()?.parse::<libc::c_int>().ok())
            .filter(|fd| *fd >= FIRST_INHERITED_DESCRIPTOR as libc::c_int)
            .collect::<Vec<_>>();
        for fd in descriptors {
            let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
            if flags == -1 {
                continue; // closed since the listing (the read_dir handle)
            }
            if unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } == -1 {
                let error = std::io::Error::last_os_error();
                tracing::warn!(fd, %error, "could not mark a descriptor close-on-exec");
            }
        }
    }
}
```

In `updates.rs::install_update`, change the restart block to:

```rust
                if restart_required_after_install(std::env::consts::OS) {
                    crate::relaunch::prepare_descriptors_for_relaunch();
                    app.restart();
                }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p bibcode-desktop --lib relaunch::tests`
Expected: PASS on Linux (the test module is Linux-only; on other targets the module compiles to the no-op).

- [ ] **Step 5: Lint**

Run: `cargo fmt --all --check && cargo clippy -p bibcode-desktop --all-targets -- -D warnings`
Expected: clean. (If clippy flags the `as libc::c_int` cast, use `libc::c_int::try_from(FIRST_INHERITED_DESCRIPTOR).unwrap_or(3)`.)

- [ ] **Step 6: Stop: the controller runs a Codex review and asks the user before committing.**

## Phase C — Contracts and the server wire (decision 2)

### Task 4: Snapshot progress fields and `installKind`

**Files:**
- Modify: `packages/contracts/src/remoteUpdate.ts`, `packages/contracts/src/remoteUpdate.test.ts`
- Modify: `apps/server/src/remote_update.rs` (types, service, tests)
- Modify: `apps/server/src/static_assets.rs`, `apps/server/src/config.rs`, `apps/server/tests/static_assets.rs`
- Modify: `apps/desktop/src-tauri/src/remote_update_delegate.rs` (`derive_remote_update_support` literals, `map_desktop_update_state` literal)
- Modify: `apps/server/tests/remote_update_rpc.rs` (literals; new fixture round-trip test)
- Modify: `packages/contracts/scripts/export-rust-rpc-fixtures.ts`, `packages/contracts/scripts/export-rust-rpc-fixtures.test.ts`, `packages/contracts/src/rpcRustParity.test.ts`
- Regenerate: `packages/contracts/fixtures/rpc-wire/manifest.json`, new `packages/contracts/fixtures/rpc-wire/contract-shapes/updater__status-success.json`
- Modify (typecheck-driven literal updates): `packages/client-runtime/src/state/remoteUpdates.test.ts`, `packages/client-runtime/src/e2ee/dockerRemoteSmoke.test.ts`, `apps/web/src/components/settings/ServerUpdateBadge.test.tsx`, `apps/web/src/components/settings/remote-servers/ConnectTab.test.tsx`, `apps/web/src/components/settings/remote-servers/ConnectTab.tsx` (the manual-override literal only), `apps/web/src/components/sidebar/EnvironmentRail.test.tsx`, `packages/contracts/src/environment.test.ts`

**Interfaces:**
- Produces (TypeScript, `@bibcode/contracts`):
  - `RemoteUpdateSupport` gains `installKind: string` (decode default `"unknown"`); known values `"archive" | "system-package" | "unknown"` exported as `REMOTE_UPDATE_INSTALL_KINDS`.
  - `RemoteUpdateSnapshot` gains `downloadPercent: number | null`, `targetVersion: string | null`, `installStage: string | null` (each decode default `null`).
- Produces (Rust, `bibcode_server::remote_update`):
  - `#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)] #[serde(rename_all = "kebab-case")] pub enum RemoteUpdateInstallKind { Archive, SystemPackage, #[default] Unknown }` (Rust only serializes it; unknown kinds from a newer server are a TypeScript-side concern, covered by Step 1)
  - `RemoteUpdateSupport { install_mode, reason, #[serde(default)] install_kind: RemoteUpdateInstallKind }` (still `Copy`); `RemoteUpdateSupport::manual()` sets `Unknown`.
  - `HostUpdaterStatus` and `RemoteUpdateSnapshot` gain `download_percent: Option<u8>`, `target_version: Option<String>`, `install_stage: Option<String>`; `HostUpdaterStatus` derives `Default` (`RemoteUpdateState` gains `#[default] Idle`).
  - `ResolvedStaticDir` gains `pub install_kind: RemoteUpdateInstallKind` (sibling `web/` → `Archive`; `<prefix>/share/bibcode/web` → `SystemPackage`; explicit → `Unknown`).

- [ ] **Step 1: Write the failing contract tests**

Append to `packages/contracts/src/remoteUpdate.test.ts` inside `describe("RemoteUpdateSnapshot", …)`:

```ts
  it("decodes an older server's snapshot with the new fields defaulted", () => {
    const snapshot = decodeSnapshot({
      serverVersion: "0.6.2",
      latestVersion: "0.6.4",
      state: "update-available",
      error: null,
      support: { installMode: "interactive", reason: "available" },
    });
    expect(snapshot.downloadPercent).toBeNull();
    expect(snapshot.targetVersion).toBeNull();
    expect(snapshot.installStage).toBeNull();
    expect(snapshot.support.installKind).toBe("unknown");
  });

  it("decodes progress, target and stage, and keeps an unknown stage and kind as strings", () => {
    const snapshot = decodeSnapshot({
      serverVersion: "0.6.2",
      latestVersion: "0.6.4",
      state: "installing",
      error: null,
      support: { installMode: "manual", reason: "manual-update-required", installKind: "flatpak" },
      downloadPercent: null,
      targetVersion: "0.6.4",
      installStage: "defragmenting-disk",
    });
    expect(snapshot.targetVersion).toBe("0.6.4");
    expect(snapshot.installStage).toBe("defragmenting-disk");
    expect(snapshot.support.installKind).toBe("flatpak");
    expect(
      decodeSnapshot({
        serverVersion: "0.6.2",
        latestVersion: "0.6.4",
        state: "downloading",
        error: null,
        support: { installMode: "interactive", reason: "available", installKind: "unknown" },
        downloadPercent: 42,
        targetVersion: "0.6.4",
        installStage: null,
      }).downloadPercent,
    ).toBe(42);
  });
```

- [ ] **Step 2: Write the failing Rust tests**

In `apps/server/src/remote_update.rs` `mod tests`, replace `snapshot_serializes_to_the_exact_contract_wire_shape` with:

```rust
    #[test]
    fn snapshot_serializes_to_the_exact_contract_wire_shape() {
        let snapshot = RemoteUpdateSnapshot {
            server_version: "0.4.2".to_owned(),
            latest_version: None,
            state: RemoteUpdateState::Idle,
            error: None,
            support: manual_support(),
            download_percent: None,
            target_version: None,
            install_stage: None,
        };
        assert_eq!(
            serde_json::to_value(&snapshot).expect("snapshot serializes"),
            json!({
                "serverVersion": "0.4.2",
                "latestVersion": null,
                "state": "idle",
                "error": null,
                "support": {
                    "installMode": "manual",
                    "reason": "manual-update-required",
                    "installKind": "unknown"
                },
                "downloadPercent": null,
                "targetVersion": null,
                "installStage": null
            })
        );
    }

    #[test]
    fn install_kind_serializes_kebab_case() {
        assert_eq!(
            serde_json::to_value(RemoteUpdateInstallKind::SystemPackage).expect("serializes"),
            json!("system-package")
        );
        assert_eq!(
            serde_json::to_value(RemoteUpdateInstallKind::Archive).expect("serializes"),
            json!("archive")
        );
    }

    #[tokio::test]
    async fn the_service_carries_the_host_progress_onto_the_snapshot() {
        struct Downloading;
        impl RemoteUpdateDelegate for Downloading {
            fn status(&self) -> HostUpdaterFuture {
                Box::pin(async {
                    HostUpdaterStatus {
                        latest_version: Some("0.6.4".to_owned()),
                        state: RemoteUpdateState::Downloading,
                        download_percent: Some(42),
                        target_version: Some("0.6.4".to_owned()),
                        ..HostUpdaterStatus::default()
                    }
                })
            }
            fn check(&self) -> HostUpdaterFuture {
                self.status()
            }
            fn request_install(&self) -> HostUpdaterFuture {
                self.status()
            }
        }
        let service = RemoteUpdateService::new(
            "0.6.2".to_owned(),
            interactive_support(),
            Some(Arc::new(Downloading)),
        );
        let snapshot = service.status().await;
        assert_eq!(snapshot.download_percent, Some(42));
        assert_eq!(snapshot.target_version.as_deref(), Some("0.6.4"));
        assert_eq!(snapshot.install_stage, None);
    }
```

(Task 7 later changes `request_install`'s signature; keep this test's impl in step with it then.)

Append to `apps/server/tests/static_assets.rs` inside the two existing packaged tests (after their `assert_eq!(resolved.path, …)`):

```rust
    // in packaged_web_is_resolved_beside_the_executable
    assert_eq!(resolved.install_kind, RemoteUpdateInstallKind::Archive);
    // in installed_web_is_resolved_from_the_executable_prefix
    assert_eq!(resolved.install_kind, RemoteUpdateInstallKind::SystemPackage);
    // in explicit_web_wins_over_packaged_assets
    assert_eq!(resolved.install_kind, RemoteUpdateInstallKind::Unknown);
```

with `use bibcode_server::remote_update::RemoteUpdateInstallKind;`. In `apps/server/src/config.rs`, extend `cli_discovers_packaged_web_from_the_injected_executable` with:

```rust
        assert_eq!(
            config.remote_update_support.install_kind,
            crate::remote_update::RemoteUpdateInstallKind::Archive
        );
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `vp test run packages/contracts/src/remoteUpdate.test.ts`
Expected: FAIL (`downloadPercent` is `undefined`, not `null`).

Run: `cargo test -p bibcode-server --lib remote_update && cargo test -p bibcode-server --test static_assets`
Expected: compile errors for the missing fields and `RemoteUpdateInstallKind`.

- [ ] **Step 4: Implement the contract**

In `packages/contracts/src/remoteUpdate.ts` (add `import * as Effect from "effect/Effect";`):

```ts
/**
 * How a headless server was installed; the client picks its manual update steps from
 * it. Decoded as a plain string so an older client keeps working when a newer server
 * adds a kind: unknown values fall back to generic steps.
 */
export const REMOTE_UPDATE_INSTALL_KINDS = ["archive", "system-package", "unknown"] as const;
export type RemoteUpdateInstallKind = (typeof REMOTE_UPDATE_INSTALL_KINDS)[number];

export const RemoteUpdateSupport = Schema.Struct({
  installMode: RemoteUpdateInstallMode,
  reason: RemoteUpdateSupportReason,
  installKind: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("unknown"))),
});

export const RemoteUpdateSnapshot = Schema.Struct({
  serverVersion: TrimmedNonEmptyString,
  latestVersion: Schema.NullOr(TrimmedNonEmptyString),
  state: RemoteUpdateState,
  error: Schema.NullOr(Schema.String),
  support: RemoteUpdateSupport,
  /** The host's download progress (0–100) while `state` is `downloading`. */
  downloadPercent: Schema.NullOr(Schema.Finite).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** The version this install applies: the available version, then the downloaded one. */
  targetVersion: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /**
   * The protection stage of the environment being protected, then `installing`. A plain
   * string: unknown stages get a generic label.
   */
  installStage: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
```

- [ ] **Step 5: Implement the Rust mirror**

In `apps/server/src/remote_update.rs`:

- Add the `RemoteUpdateInstallKind` enum from **Interfaces**, and the field to `RemoteUpdateSupport`:

```rust
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteUpdateSupport {
    pub install_mode: RemoteUpdateInstallMode,
    pub reason: RemoteUpdateSupportReason,
    #[serde(default)]
    pub install_kind: RemoteUpdateInstallKind,
}
```

  `manual()` sets `install_kind: RemoteUpdateInstallKind::Unknown`.
- `RemoteUpdateState` derives `Default` with `#[default]` on `Idle`.
- `RemoteUpdateSnapshot` gains, after `support`:

```rust
    pub download_percent: Option<u8>,
    pub target_version: Option<String>,
    pub install_stage: Option<String>,
```

- `HostUpdaterStatus` gets `#[derive(Clone, Debug, Default, Eq, PartialEq)]` and the same three fields with doc comments ("percent while downloading", "the version this install applies", "protection stage, then `installing`").
- `snapshot()` copies the three fields; `manual_status()` and the timeout status in `await_delegate` use `..HostUpdaterStatus::default()`.
- Update every `HostUpdaterStatus { … }` and `RemoteUpdateSupport { … }` literal the compiler names: the test helpers `manual_support`/`interactive_support`, `FixtureDelegate`, `PendingHostUpdater`, `apps/server/src/config.rs::server_config_defaults_to_manual_remote_update_support`, `apps/server/tests/remote_update_rpc.rs` (`FixtureHostUpdater`, the `with_remote_update_support(…)` literal), and `apps/desktop/src-tauri/src/remote_update_delegate.rs` (the three `derive_remote_update_support` literals get `install_kind: RemoteUpdateInstallKind::Unknown`; `map_desktop_update_state` returns `HostUpdaterStatus { latest_version, state: mapped, error, ..HostUpdaterStatus::default() }` until Task 8 fills the new fields).

In `apps/server/src/static_assets.rs`, add `pub install_kind: RemoteUpdateInstallKind` to `ResolvedStaticDir` and set it in the three constructors (`Explicit` → `Unknown`, sibling `web` → `Archive`, `share/bibcode/web` → `SystemPackage`). In `apps/server/src/config.rs` right after `config.static_dir_source = …`:

```rust
        config.remote_update_support.install_kind = resolved_static_dir
            .as_ref()
            .map_or(RemoteUpdateInstallKind::Unknown, |resolved| resolved.install_kind);
```

(move the `resolved_static_dir.map(|resolved| resolved.source)` line to `.as_ref().map(…)` so the value is not consumed first).

- [ ] **Step 6: Add the contract-shape fixture and its Rust round-trip**

In `packages/contracts/scripts/export-rust-rpc-fixtures.ts`, import `RemoteUpdateSnapshot` from `../src/remoteUpdate.ts` and add next to the other `dynamicFixtures.set(…)` calls:

```ts
const fixtureRemoteUpdateSnapshot = {
  serverVersion: "0.6.2",
  latestVersion: "0.6.4",
  state: "downloading",
  error: null,
  support: { installMode: "interactive", reason: "available", installKind: "unknown" },
  downloadPercent: 42,
  targetVersion: "0.6.4",
  installStage: null,
} satisfies typeof RemoteUpdateSnapshot.Type;
dynamicFixtures.set(
  "contract-shapes/updater__status-success.json",
  stripEffectOptionIds(
    serializeWireFixture({
      _tag: "Exit",
      requestId,
      exit: {
        _tag: "Success",
        value: compileUnknownEncoder(RemoteUpdateSnapshot)(fixtureRemoteUpdateSnapshot),
      },
    } satisfies RpcMessage.ResponseExitEncoded),
  ),
);
```

In `export-rust-rpc-fixtures.test.ts`, change `expect(manifest.fixtures).toHaveLength(389)` to `390`.

In `packages/contracts/src/rpcRustParity.test.ts`, add:

```ts
  it("pins the remote update snapshot wire shape the Rust mirror round-trips", () => {
    const fixtureDirectory = NodePath.resolve(import.meta.dirname, "../fixtures/rpc-wire");
    const fixture = JSON.parse(
      NodeFS.readFileSync(
        NodePath.join(fixtureDirectory, "contract-shapes/updater__status-success.json"),
        "utf8",
      ),
    ) as { readonly exit: { readonly value: unknown } };
    expect(fixture.exit.value).toEqual({
      serverVersion: "0.6.2",
      latestVersion: "0.6.4",
      state: "downloading",
      error: null,
      support: { installMode: "interactive", reason: "available", installKind: "unknown" },
      downloadPercent: 42,
      targetVersion: "0.6.4",
      installStage: null,
    });
  });
```

Append to `apps/server/tests/remote_update_rpc.rs`:

```rust
#[test]
fn the_status_contract_shape_round_trips_through_the_rust_snapshot() {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(
        "../../packages/contracts/fixtures/rpc-wire/contract-shapes/updater__status-success.json",
    );
    let fixture: Value =
        serde_json::from_str(&std::fs::read_to_string(path).expect("contract-shape fixture"))
            .expect("fixture JSON");
    let wire = fixture["exit"]["value"].clone();
    let snapshot: bibcode_server::RemoteUpdateSnapshot =
        serde_json::from_value(wire.clone()).expect("the Rust mirror decodes the TS shape");
    assert_eq!(snapshot.download_percent, Some(42));
    assert_eq!(
        serde_json::to_value(&snapshot).expect("snapshot re-encodes"),
        wire,
        "the Rust mirror must stay byte-identical to the TypeScript contract"
    );
}
```

- [ ] **Step 7: Regenerate fixtures and run the contract gate (temporary index)**

Run the focused tests first:
- `vp test run packages/contracts/src/remoteUpdate.test.ts packages/contracts/scripts/export-rust-rpc-fixtures.test.ts`
- `cargo test -p bibcode-server --lib remote_update && cargo test -p bibcode-server --test static_assets --test remote_update_rpc`

Then regenerate and gate. `check:contracts` ends with `git diff --exit-code` against the index, so use a temporary fixture-only index; this never touches the real index or other agents' changes:

```bash
(
  set -eu
  node packages/contracts/scripts/export-rust-rpc-fixtures.ts
  git status --short -- packages/contracts/fixtures
  git diff --stat -- packages/contracts/fixtures
  CONTRACT_INDEX=$(mktemp)
  trap 'rm -f "$CONTRACT_INDEX"' EXIT
  GIT_INDEX_FILE="$CONTRACT_INDEX" git read-tree HEAD
  GIT_INDEX_FILE="$CONTRACT_INDEX" git add -- packages/contracts/fixtures
  GIT_INDEX_FILE="$CONTRACT_INDEX" vp run check:contracts
)
```

Expected: status lists the untracked `contract-shapes/updater__status-success.json` and a modified `manifest.json` (one added fixture path; `typed-failures/updater__*` and `stream-shapes/*` unchanged); review both diffs in full before the gate; the gate exits **0**. Record `check:contracts: PASS (exit 0, temporary fixture index)` in the ledger; any nonzero exit is a failure.

- [ ] **Step 8: Fix typed literals and typecheck**

Run: `vp run typecheck`
Expected before fixes: errors of the form `Property 'downloadPercent' is missing in type …` or `Property 'installKind' is missing …` in the files listed under **Files**. Add `downloadPercent: null, targetVersion: null, installStage: null` to each typed `RemoteUpdateSnapshot` literal and `installKind: "unknown"` to each typed `RemoteUpdateSupport` literal. In `ConnectTab.tsx` change the manual-override literal to keep the kind:

```ts
            support: {
              ...queryStatus.snapshot.support,
              installMode: "manual",
              reason: "manual-update-required",
            },
```

Re-run `vp run typecheck` until clean, then:
- `vp test run packages/client-runtime/src/state/remoteUpdates.test.ts apps/web/src/components/settings/ServerUpdateBadge.test.tsx apps/web/src/components/settings/remote-servers/ConnectTab.test.tsx apps/web/src/components/sidebar/EnvironmentRail.test.tsx packages/contracts/src/environment.test.ts`
- `cargo test -p bibcode-desktop --lib remote_update_delegate`

Expected: PASS.

- [ ] **Step 9: Lint**

Run: `cargo fmt --all --check && cargo clippy -p bibcode-server --all-targets -- -D warnings && cargo clippy -p bibcode-desktop --all-targets -- -D warnings`
Expected: clean.

- [ ] **Step 10: Stop: the controller runs a Codex review and asks the user before committing.**

### Task 5: `bootId` and the `remoteUpdateProgress` capability on every descriptor

**Files:**
- Modify: `packages/contracts/src/environment.ts`, `packages/contracts/src/environment.test.ts`
- Modify: `packages/shared/src/testSupport.ts` (`makeTestExecutionEnvironmentCapabilities`)
- Modify: `apps/server/src/config.rs` (`ServerConfig.boot_id`)
- Modify: `apps/server/src/lifecycle.rs` (`start_internal`, `connect_environment_descriptor`, its test)
- Modify: `apps/server/src/http.rs` (`EnvironmentDescriptor`, `EnvironmentCapabilities`, `environment_descriptor`)
- Modify: `apps/server/src/production/control.rs` (`environment_descriptor`, its test)
- Modify: `apps/server/tests/remote_update_rpc.rs`
- Modify: `packages/contracts/scripts/export-rust-rpc-fixtures.ts` (`fixtureEnvironmentDescriptor`)
- Regenerate: `packages/contracts/fixtures/rpc-wire/stream-shapes/subscribeServerConfig-0*.json`, `subscribeServerLifecycle-0*.json`, `manifest.json`
- Modify (typecheck-driven): typed `ExecutionEnvironmentDescriptor` literals, known candidates: `apps/web/src/tauriDesktopBridge.test.ts`, `apps/web/src/versionSkew.test.ts`, `apps/web/src/cloud/linkEnvironment.test.ts`, `apps/web/src/connection/storage.test.ts`, `apps/web/src/environments/primary/bootstrap.test.ts`, `packages/client-runtime/src/connection/{supervisor,driver,registry,resolver,pairingAdd}.test.ts`, `packages/client-runtime/src/authorization/layer.test.ts`, `packages/client-runtime/src/state/session.test.ts`, `packages/client-runtime/src/rpc/session.test.ts`, `packages/client-runtime/src/environment/knownEnvironment.test.ts`

**Interfaces:**
- Produces (TypeScript): `ExecutionEnvironmentDescriptor.bootId: string | null` (decode default `null`); `ExecutionEnvironmentCapabilities.remoteUpdateProgress: boolean` (decode default `false`).
- Produces (Rust): `pub boot_id: Option<uuid::Uuid>` on `ServerConfig` (default `None`), set to `Some(Uuid::new_v4())` in `start_internal` on every start; each descriptor producer serializes it as `"bootId"` and advertises `"remoteUpdateProgress": true`. Never persisted; storage identity is untouched.

- [ ] **Step 1: Write the failing tests**

In `packages/contracts/src/environment.test.ts`, add a case (reuse the file's minimal descriptor fixture; if its name differs, copy one existing decode case):

```ts
  it("defaults bootId and remoteUpdateProgress for an older server", () => {
    const descriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor)({
      environmentId: "remote-1",
      label: "Ai-server",
      platform: { os: "linux", arch: "x64" },
      serverVersion: "0.6.2",
      capabilities: {},
    });
    expect(descriptor.bootId).toBeNull();
    expect(descriptor.capabilities.remoteUpdateProgress).toBe(false);
  });
```

In `apps/server/tests/remote_update_rpc.rs`, extend `headless_server_answers_manual_update_surface` after the `remoteUpdateSupport` assertion:

```rust
    assert_eq!(descriptor["capabilities"]["remoteUpdateProgress"], true);
    let boot_id = descriptor["bootId"].as_str().expect("descriptor carries a bootId");
    assert!(uuid::Uuid::parse_str(boot_id).is_ok());
```

and add:

```rust
#[tokio::test]
async fn boot_id_changes_on_every_start_while_storage_identity_stays() {
    let temp = TempDir::new().expect("data root");
    disable_provider_processes(temp.path());
    let config = || {
        ServerConfig::new(temp.path())
            .with_bind("127.0.0.1", 0)
            .with_unsafe_no_auth()
    };
    let descriptor = |handle: &bibcode_server::ServerHandle| {
        let url = format!(
            "http://{}/.well-known/bibcode/environment",
            handle.local_addr()
        );
        async move {
            reqwest::get(url)
                .await
                .expect("descriptor fetch")
                .json::<Value>()
                .await
                .expect("descriptor JSON")
        }
    };

    let first = ServerRuntime::start(config()).await.expect("first start");
    let first_descriptor = descriptor(&first).await;
    first.shutdown();
    first.join().await.expect("first joins");
    let second = ServerRuntime::start(config()).await.expect("second start");
    let second_descriptor = descriptor(&second).await;
    second.shutdown();
    second.join().await.expect("second joins");

    assert_ne!(first_descriptor["bootId"], second_descriptor["bootId"]);
    assert_eq!(
        first_descriptor["storageInstanceId"],
        second_descriptor["storageInstanceId"]
    );
}
```

In `apps/server/src/production/control.rs`, extend `environment_descriptor_advertises_remote_update_control_and_support`, and in `apps/server/src/lifecycle.rs` extend `connect_descriptor_advertises_remote_update_support`, each with (after setting `config.boot_id = Some(uuid::Uuid::nil());` in the test's config setup):

```rust
        assert_eq!(descriptor["bootId"], "00000000-0000-0000-0000-000000000000");
        assert_eq!(descriptor["capabilities"]["remoteUpdateProgress"], true);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `vp test run packages/contracts/src/environment.test.ts`
Expected: FAIL (`bootId` is `undefined`).

Run: `cargo test -p bibcode-server --test remote_update_rpc && cargo test -p bibcode-server --lib control::tests::environment_descriptor lifecycle::tests::connect_descriptor`
Expected: compile error `no field boot_id on type ServerConfig`.

- [ ] **Step 3: Implement**

`packages/contracts/src/environment.ts`: add to `ExecutionEnvironmentCapabilities`

```ts
  /** The server reports update progress, `bootId` and `updater.activeWork`. */
  remoteUpdateProgress: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
```

and to `ExecutionEnvironmentDescriptor`, after `storageInstanceId`:

```ts
  /** Random for each server start; never persisted and never a storage identity. */
  bootId: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
```

`packages/shared/src/testSupport.ts`: add `remoteUpdateProgress: false,` to the defaults.

Rust:
- `config.rs`: add `pub boot_id: Option<uuid::Uuid>,` (doc: "Random per start; set by `ServerRuntime`; never persisted.") with `boot_id: None` in `ServerConfig::new`.
- `lifecycle.rs::start_internal`: right after `config.storage_instance_id = Some(prepared_store.storage_instance_id);` add `config.boot_id = Some(uuid::Uuid::new_v4());`.
- `lifecycle.rs::connect_environment_descriptor`, `control.rs::environment_descriptor`: add `"bootId": config.boot_id.map(|id| id.to_string()),` after `storageInstanceId`, and `"remoteUpdateProgress": true,` after `"remoteUpdateControl": true,`.
- `http.rs`: add `boot_id: Option<String>` to `EnvironmentDescriptor` (after `storage_instance_id`), `remote_update_progress: bool` to `EnvironmentCapabilities`, and set them from `config.boot_id.map(|id| id.to_string())` and `true`.

Exporter: add `bootId: "00000000-0000-4000-8000-000000000003",` to `fixtureEnvironmentDescriptor` after `storageInstanceId`.

- [ ] **Step 4: Regenerate, gate, and fix typed literals**

Run the focused tests:
- `vp test run packages/contracts/src/environment.test.ts`
- `cargo test -p bibcode-server --test remote_update_rpc && cargo test -p bibcode-server --lib control::tests lifecycle::tests`

Then run the temporary-index block from Task 4 Step 7 verbatim. Expected: modified `stream-shapes/subscribeServerConfig-0*.json` and `subscribeServerLifecycle-0*.json` (each gains `"bootId"`) plus their fingerprints in `manifest.json`; the gate exits **0**.

Then `vp run typecheck`; add `bootId: null` to each typed descriptor literal it names (candidates under **Files**; some are edited by other agents, so re-read and make one-line edits) until clean. Run `vp test run packages/client-runtime/src/connection packages/client-runtime/src/state/session.test.ts packages/client-runtime/src/rpc/session.test.ts apps/web/src/versionSkew.test.ts apps/web/src/tauriDesktopBridge.test.ts`.
Expected: PASS.

- [ ] **Step 5: Lint**

Run: `cargo fmt --all --check && cargo clippy -p bibcode-server --all-targets -- -D warnings`
Expected: clean.

- [ ] **Step 6: Stop: the controller runs a Codex review and asks the user before committing.**

### Task 6: `updater.activeWork`

**Files:**
- Modify: `packages/contracts/src/remoteUpdate.ts` (`RemoteUpdateActiveWork`), `packages/contracts/src/remoteUpdate.test.ts`
- Modify: `packages/contracts/src/rpc.ts` (`WS_METHODS.updaterActiveWork`, `WsUpdaterActiveWorkRpc`, group list)
- Modify: `apps/server/src/rpc/methods.rs`, `apps/server/src/auth/scope.rs` (+ its test)
- Modify: `apps/server/src/persistence/repositories.rs` (`count_active_work`)
- Modify: `apps/server/src/terminal/manager.rs` (`live_session_count`), `apps/server/src/production/server_terminal.rs` (`live_terminal_count`)
- Modify: `apps/server/src/production/remote_update_rpc.rs` (`ActiveWorkCounter`, registration)
- Modify: `apps/server/src/production/runtime.rs` (the `register_remote_update_rpc(…)` call only)
- Modify: `apps/server/tests/rpc_wire.rs`, `apps/server/tests/remote_update_rpc.rs`, `apps/server/tests/repositories.rs`
- Modify: `packages/contracts/scripts/export-rust-rpc-fixtures.test.ts`
- Regenerate: `manifest.json`, new `typed-failures/updater__activeWork-00.json`, `-01.json`

**Interfaces:**
- Produces (TypeScript): `RemoteUpdateActiveWork = Schema.Struct({ runningTurns: NonNegativeInt, liveTerminals: NonNegativeInt, queuedMessages: NonNegativeInt })`; `WS_METHODS.updaterActiveWork = "updater.activeWork"`; `WsUpdaterActiveWorkRpc` (payload `{}`, success `RemoteUpdateActiveWork`, error `EnvironmentRpcError`).
- Produces (Rust):
  - `Repositories::count_active_work(&self) -> Result<(u64, u64)>` — `(running thread sessions, queued provider turns)` in one database call.
  - `TerminalManager::live_session_count(&self) -> usize` (async) — sessions whose status is `Starting` or `Running`.
  - `ServerTerminalServices::live_terminal_count(&self) -> usize` (async).
  - `pub struct ActiveWorkCounter { repositories: Repositories, terminals: ServerTerminalServices }` with `pub async fn count(&self) -> Result<serde_json::Value, serde_json::Value>`.
  - `register_remote_update_rpc(registry, service, active_work: ActiveWorkCounter)`.

- [ ] **Step 1: Write the failing tests**

`packages/contracts/src/remoteUpdate.test.ts`:

```ts
describe("RemoteUpdateActiveWork", () => {
  it("decodes the counts and rejects negative values", () => {
    const decode = Schema.decodeUnknownSync(RemoteUpdateActiveWork);
    expect(decode({ runningTurns: 2, liveTerminals: 3, queuedMessages: 1 })).toEqual({
      runningTurns: 2,
      liveTerminals: 3,
      queuedMessages: 1,
    });
    expect(() => decode({ runningTurns: -1, liveTerminals: 0, queuedMessages: 0 })).toThrow();
  });
});
```

`apps/server/src/auth/scope.rs` test: add after the `updater.status` assertion

```rust
        assert_eq!(
            required_scope("updater.activeWork"),
            Some(SCOPE_ORCHESTRATION_READ)
        );
```

`apps/server/tests/remote_update_rpc.rs`:

```rust
#[tokio::test]
async fn active_work_counts_across_clients_and_starts_at_zero() {
    let temp = TempDir::new().expect("data root");
    disable_provider_processes(temp.path());
    let handle = ServerRuntime::start(
        ServerConfig::new(temp.path())
            .with_bind("127.0.0.1", 0)
            .with_unsafe_no_auth(),
    )
    .await
    .expect("server starts");
    let (mut first, _) = connect_async(format!("ws://{}/ws", handle.local_addr()))
        .await
        .expect("first client");
    let (mut second, _) = connect_async(format!("ws://{}/ws", handle.local_addr()))
        .await
        .expect("second client");

    let ServerMessage::Exit {
        exit: RpcExit::Success { value: Some(idle) },
        ..
    } = call_unary(&mut first, "1", "updater.activeWork").await
    else {
        panic!("updater.activeWork must succeed");
    };
    assert_eq!(
        idle,
        json!({ "runningTurns": 0, "liveTerminals": 0, "queuedMessages": 0 })
    );

    let ServerMessage::Exit {
        exit: RpcExit::Success { value: Some(from_second) },
        ..
    } = call_unary(&mut second, "2", "updater.activeWork").await
    else {
        panic!("updater.activeWork must succeed for every client");
    };
    assert_eq!(from_second, idle);

    first.close(None).await.expect("close first");
    second.close(None).await.expect("close second");
    handle.shutdown();
    handle.join().await.expect("server joins");
}
```

The counts themselves are tested where the data lives. In `apps/server/tests/repositories.rs` (next to `requeue_provider_turn_is_attempt_conditioned_and_preserves_payload`, reusing its `migrated_repositories`, `T0`/`T1` and raw-SQL fixture style):

```rust
#[tokio::test]
async fn active_work_counts_running_sessions_and_every_queued_message() {
    let repositories = migrated_repositories().await;
    assert_eq!(repositories.count_active_work().await.unwrap(), (0, 0));
    for (thread_id, status) in [("busy", "running"), ("waiting", "ready")] {
        repositories
            .upsert_thread_session(ProjectionThreadSession {
                thread_id: thread_id.into(),
                status: status.into(),
                provider_name: Some("codex".into()),
                provider_instance_id: Some("codex".into()),
                runtime_mode: "approval-required".into(),
                active_turn_id: None,
                last_error: None,
                last_error_class: None,
                updated_at: T0.into(),
            })
            .await
            .unwrap();
    }
    repositories.database().call(|connection| {
        for (command, state) in [("q1", "queued"), ("q2", "queued"), ("sent", "delivered")] {
            connection.execute("INSERT INTO orchestration_command_receipts (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status) VALUES (?, 'thread', 'busy', ?, 0, 'accepted')", [command, T0])?;
            connection.execute("INSERT INTO provider_turn_outbox (command_id, thread_id, message_id, provider_instance_id, provider_kind, delivery_key, payload_json, state, mode, held, attempts, last_error, created_at, updated_at) VALUES (?, 'busy', ?, 'codex', 'codex', ?, '{}', ?, 'start', 0, 0, NULL, ?, ?)", [command, command, command, state, T0, T1])?;
        }
        Ok(())
    }).await.unwrap();
    assert_eq!(repositories.count_active_work().await.unwrap(), (1, 2));
}
```

Add `"count_active_work"` to the sorted method list in `public_repository_api_inventory_is_explicit` in the same file. In `apps/server/src/terminal/manager.rs` `mod tests`, next to the size tests that use `size_fixture`:

```rust
    #[tokio::test]
    async fn live_session_count_counts_open_sessions_until_they_close() {
        let (_root, _backend, manager) = size_fixture(80, 24).await;
        assert_eq!(manager.live_session_count().await, 1);
        manager.close("sizing", Some("term")).await.unwrap();
        assert_eq!(manager.live_session_count().await, 0);
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `vp test run packages/contracts/src/remoteUpdate.test.ts`
Expected: FAIL (`RemoteUpdateActiveWork` is not exported).

Run: `cargo test -p bibcode-server --test remote_update_rpc -- active_work && cargo test -p bibcode-server --test repositories -- active_work public_repository_api && cargo test -p bibcode-server --lib auth::scope terminal::manager::tests::live_session_count`
Expected: FAIL — compile errors for `count_active_work` and `live_session_count`; after stubbing, the scope assertion returns `None` and the RPC test gets an unknown-method failure.

- [ ] **Step 3: Implement the contract**

`packages/contracts/src/remoteUpdate.ts` (import `NonNegativeInt` from `./baseSchemas.ts`):

```ts
/** Work an update restart would stop, counted across all clients of the server. */
export const RemoteUpdateActiveWork = Schema.Struct({
  runningTurns: NonNegativeInt,
  liveTerminals: NonNegativeInt,
  queuedMessages: NonNegativeInt,
});
export type RemoteUpdateActiveWork = typeof RemoteUpdateActiveWork.Type;
```

`packages/contracts/src/rpc.ts`: add `updaterActiveWork: "updater.activeWork",` under `// Remote updater methods` (before `updaterStatus`), import `RemoteUpdateActiveWork`, and:

```ts
export const WsUpdaterActiveWorkRpc = Rpc.make(WS_METHODS.updaterActiveWork, {
  payload: Schema.Struct({}),
  success: RemoteUpdateActiveWork,
  error: EnvironmentRpcError,
});
```

Add `WsUpdaterActiveWorkRpc,` before `WsUpdaterStatusRpc,` in the group list (~line 1607). Confirm `packages/contracts/src/index.ts` re-exports `remoteUpdate.ts` with `export *` (it does for the existing snapshot); add nothing if so.

- [ ] **Step 4: Implement the server**

- `apps/server/src/rpc/methods.rs`: insert `read_unary("updater.activeWork"),` immediately before `mutation_unary("updater.check"),`.
- `apps/server/src/auth/scope.rs`: add `| "updater.activeWork"` to the `SCOPE_ORCHESTRATION_READ` arm next to `"updater.status"`.
- `repositories.rs`:

```rust
    /// Running provider turns and queued messages, for the update confirmation.
    pub async fn count_active_work(&self) -> Result<(u64, u64)> {
        self.database
            .call(|connection| {
                let running: i64 = connection.query_row(
                    "SELECT COUNT(*) FROM projection_thread_sessions WHERE status = 'running'",
                    [],
                    |row| row.get(0),
                )?;
                let queued: i64 = connection.query_row(
                    "SELECT COUNT(*) FROM provider_turn_outbox WHERE state = 'queued'",
                    [],
                    |row| row.get(0),
                )?;
                // COUNT(*) is never negative.
                Ok((
                    u64::try_from(running).unwrap_or(0),
                    u64::try_from(queued).unwrap_or(0),
                ))
            })
            .await
    }
```

  (`list_thread_sessions_by_status` and `list_queued_provider_turn_heads` show these table and state names; a COUNT avoids loading payloads.)
- `terminal/manager.rs`, next to `subscribe_metadata`:

```rust
    /// Terminal sessions whose process is starting or running.
    pub async fn live_session_count(&self) -> usize {
        let sessions = self.inner.sessions.read().await;
        let mut live = 0;
        for session in sessions.values() {
            if matches!(
                session.lock().await.summary().status,
                TerminalStatus::Starting | TerminalStatus::Running
            ) {
                live += 1;
            }
        }
        live
    }
```

- `production/server_terminal.rs`: `pub async fn live_terminal_count(&self) -> usize { self.terminal.live_session_count().await }`.
- `production/remote_update_rpc.rs`:

```rust
use serde_json::{Value, json};

use crate::{
    persistence::Repositories, production::server_terminal::ServerTerminalServices,
    remote_update::RemoteUpdateService, rpc::RpcRegistry,
};

/// Counts the work an update restart would stop. Its own read method: status is
/// polled every second and must never wait on the store.
#[derive(Clone)]
pub struct ActiveWorkCounter {
    repositories: Repositories,
    terminals: ServerTerminalServices,
}

impl ActiveWorkCounter {
    #[must_use]
    pub fn new(repositories: Repositories, terminals: ServerTerminalServices) -> Self {
        Self { repositories, terminals }
    }

    pub async fn count(&self) -> Result<Value, Value> {
        let (running_turns, queued_messages) =
            self.repositories.count_active_work().await.map_err(|error| {
                tracing::warn!(%error, "could not count running work for an update confirmation");
                // Not part of the method's typed errors on purpose: the client treats any
                // failed read as "cannot count" and shows the no-count confirmation line.
                json!({
                    "_tag": "RemoteUpdateActiveWorkUnavailable",
                    "message": "Could not count running work.",
                })
            })?;
        let live_terminals = self.terminals.live_terminal_count().await;
        Ok(json!({
            "runningTurns": running_turns,
            "liveTerminals": live_terminals,
            "queuedMessages": queued_messages,
        }))
    }
}
```

  `EnvironmentRpcError` is only the authorization/maintenance union (`packages/contracts/src/auth.ts`), so there is no generic typed error to reuse; the untyped failure above reaches the client as a failed read, which Task 13 renders as the no-count line. Register:

```rust
    registry.register_unary("updater.activeWork", move |_request, _cancellation| {
        let counter = active_work.clone();
        async move { counter.count().await }
    });
```

- `production/runtime.rs`: pass `crate::production::remote_update_rpc::ActiveWorkCounter::new(repositories.clone(), terminal_services.clone())` as the new third argument (both are in scope at the call; if `repositories` has another local name there, use it).

- [ ] **Step 5: Update the pinned counts, regenerate, gate**

- `apps/server/tests/rpc_wire.rs`: `rust_methods.len()` 131 → 132; `typed_failure_fixtures.len()` 288 → 290.
- `export-rust-rpc-fixtures.test.ts`: `methods` 131 → 132; `typedFailureFixtures` 288 → 290; `fixtures` 390 → 392; `schemaFingerprints` 359 → 361.

(If the liveness plan has already landed and changed these numbers, add +1 method, +2 typed failures, +2 fixtures, +2 fingerprints to the current values instead.)

Run:
- `vp test run packages/contracts/src/remoteUpdate.test.ts`
- `cargo test -p bibcode-server --test remote_update_rpc --test repositories && cargo test -p bibcode-server --lib auth::scope terminal::manager`
- The temporary-index block from Task 4 Step 7. Expected: new untracked `typed-failures/updater__activeWork-00.json` and `-01.json`, `manifest.json` gains the method and the two fixtures; the gate exits **0** (it also runs `cargo test -p bibcode-server --test rpc_wire`).

- [ ] **Step 6: Lint**

Run: `cargo fmt --all --check && cargo clippy -p bibcode-server --all-targets -- -D warnings`
Expected: clean.

- [ ] **Step 7: Stop: the controller runs a Codex review and asks the user before committing.**

### Task 7: `updater.install` passes the requester and logs it once

**Files:**
- Modify: `apps/server/src/remote_update.rs` (`RemoteUpdateRequester`, trait, service, tests)
- Modify: `apps/server/src/rpc/session.rs` (`RpcSessionContext::current_client_metadata`)
- Modify: `apps/server/src/production/remote_update_rpc.rs` (`updater.install` handler)
- Modify: `apps/server/src/lib.rs` (re-export `RemoteUpdateRequester`)
- Modify: `apps/desktop/src-tauri/src/remote_update_delegate.rs` (trait impl signature only; Task 8 uses the value)
- Test: `apps/server/tests/remote_update_rpc.rs`

**Interfaces:**
- Produces:

```rust
/// Who asked for a remote install, from the caller's paired-client metadata. Every
/// field is optional: an unauthenticated server knows none of them.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RemoteUpdateRequester {
    pub label: Option<String>,
    pub os: Option<String>,
    pub ip_address: Option<String>,
    /// The first 8 characters of the caller's session id; never the whole id.
    pub session_id_prefix: Option<String>,
}
```

  - `RemoteUpdateDelegate::request_install(&self, requester: RemoteUpdateRequester) -> HostUpdaterFuture`
  - `RemoteUpdateService::install(&self, requester: RemoteUpdateRequester) -> Result<RemoteUpdateSnapshot, Value>`
  - `RpcSessionContext::current_client_metadata(&self) -> Option<ClientMetadata>` (`pub(crate)`, async; `None` when unauthenticated).
- Log line (target `bibcode_server::remote_update`): `info!` "remote update install requested" with fields `requester_label`, `requester_os`, `requester_address`, `requester_session`, `server_version`, `target_version`; `warn!` "remote update install request failed" with the same fields plus `error` when the reply is `error`.

- [ ] **Step 1: Write the failing tests**

In `remote_update.rs` `mod tests`, change the three test delegates to take `_requester: RemoteUpdateRequester` and add a recording delegate test:

```rust
    #[tokio::test]
    async fn install_hands_the_requester_to_the_delegate() {
        struct Recording(std::sync::Mutex<Vec<RemoteUpdateRequester>>);
        impl RemoteUpdateDelegate for Recording {
            fn status(&self) -> HostUpdaterFuture {
                Box::pin(async { HostUpdaterStatus::default() })
            }
            fn check(&self) -> HostUpdaterFuture {
                self.status()
            }
            fn request_install(&self, requester: RemoteUpdateRequester) -> HostUpdaterFuture {
                self.0.lock().expect("requests").push(requester);
                self.status()
            }
        }
        let delegate = Arc::new(Recording(std::sync::Mutex::new(Vec::new())));
        let service = RemoteUpdateService::new(
            "0.6.2".to_owned(),
            interactive_support(),
            Some(delegate.clone()),
        );
        let requester = RemoteUpdateRequester {
            label: Some("BiBCode Desktop".to_owned()),
            os: Some("MacIntel".to_owned()),
            ip_address: None,
            session_id_prefix: Some("0123abcd".to_owned()),
        };
        service
            .install(requester.clone())
            .await
            .expect("interactive install accepted");
        assert_eq!(*delegate.0.lock().expect("requests"), vec![requester]);
    }
```

In `apps/server/tests/remote_update_rpc.rs`, make `FixtureHostUpdater` record requesters — `#[derive(Default)] struct FixtureHostUpdater { requests: std::sync::Mutex<Vec<RemoteUpdateRequester>> }`, its `request_install` pushes the requester — change the existing `Arc::new(FixtureHostUpdater)` to `Arc::new(FixtureHostUpdater::default())`, and add an authenticated test modelled on `revoking_a_client_terminates_its_live_websocket` in `tests/auth_http.rs` (copy its `exchange_token`, `websocket_ticket`, `access_token`, `get_json`, `http_url`, `token_form` helpers and the three token-type constants into this file):

```rust
#[tokio::test]
async fn install_passes_the_callers_client_metadata_and_logs_the_request_once() {
    const BOOTSTRAP: &str = "remote-update-bootstrap";
    let temp = TempDir::new().expect("data root");
    disable_provider_processes(temp.path());
    let config = ServerConfig::new(temp.path())
        .with_bind("127.0.0.1", 0)
        .with_desktop(BOOTSTRAP)
        .expect("desktop config")
        .with_remote_update_support(RemoteUpdateSupport {
            install_mode: RemoteUpdateInstallMode::Interactive,
            reason: RemoteUpdateSupportReason::Available,
            install_kind: RemoteUpdateInstallKind::Unknown,
        });
    let log_path = bibcode_server::persistence::StatePaths::from_config(&config).server_log;
    let updater = Arc::new(FixtureHostUpdater::default());
    let handle = ServerRuntime::start_with_desktop_integration(
        config,
        Arc::new(bibcode_server::diagnostics::UnavailableDesktopUiProcessObserver),
        updater.clone(),
    )
    .await
    .expect("server starts");
    let client = reqwest::Client::new();
    let administrator = exchange_token(&client, &handle, BOOTSTRAP, None).await;
    let pairing = get_json(
        client
            .post(http_url(&handle, "/api/auth/pairing-token"))
            .bearer_auth(access_token(&administrator))
            .json(&json!({ "label": "Tablet" }))
            .send()
            .await
            .expect("pairing"),
        reqwest::StatusCode::OK,
    )
    .await;
    let paired = exchange_token(
        &client,
        &handle,
        pairing["credential"].as_str().expect("credential"),
        None,
    )
    .await;
    let ticket = websocket_ticket(&client, &handle, access_token(&paired)).await;
    let (mut socket, _) = connect_async(format!(
        "ws://{}/ws?wsTicket={ticket}",
        handle.local_addr()
    ))
    .await
    .expect("paired WebSocket");

    let install = call_unary(&mut socket, "1", "updater.install").await;
    assert!(matches!(
        install,
        ServerMessage::Exit { exit: RpcExit::Success { .. }, .. }
    ));
    let requests = updater.requests.lock().expect("requests").clone();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].label.as_deref(), Some("Tablet"));
    assert_eq!(
        requests[0].session_id_prefix.as_ref().map(String::len),
        Some(8)
    );

    socket.close(None).await.expect("close socket");
    handle.shutdown();
    handle.join().await.expect("server joins");
    let log = std::fs::read_to_string(log_path).expect("server log");
    // Tracing is one process-wide stream mirrored to every live runtime's server.log,
    // so count only lines that carry this test's requester, not the bare message.
    let prefix = requests[0].session_id_prefix.clone().expect("session prefix");
    let ours = log
        .lines()
        .filter(|line| line.contains("remote update install requested"))
        .filter(|line| line.contains("Tablet") && line.contains(&prefix))
        .count();
    assert_eq!(ours, 1, "exactly one requester line for this install: {log}");
    assert!(!log.contains(access_token(&paired)), "no credentials in the log");
}
```

Check what label the store records for a pairing-token exchange (the `auth_http.rs` tests show `client.label == "Paired client"` for `{"label": "Paired client"}`); assert that value. `ip_address` is not recorded by the auth store today (`auth/http.rs::client_metadata` sets `ip_address: None`); see open question 5 — do not assert an address.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p bibcode-server --lib remote_update && cargo test -p bibcode-server --test remote_update_rpc -- install_passes`
Expected: compile errors (`request_install` takes no requester; `RemoteUpdateRequester` missing).

- [ ] **Step 3: Implement**

- `remote_update.rs`: add `RemoteUpdateRequester` (Interfaces), change the trait method, and:

```rust
    pub async fn install(
        &self,
        requester: RemoteUpdateRequester,
    ) -> Result<RemoteUpdateSnapshot, Value> {
        let Some(delegate) = self.interactive_delegate() else {
            return Err(remote_update_manual_required_error());
        };
        let status = self
            .await_delegate(delegate.request_install(requester.clone()))
            .await;
        let snapshot = self.snapshot(status);
        tracing::info!(
            requester_label = requester.label.as_deref().unwrap_or("unknown"),
            requester_os = requester.os.as_deref().unwrap_or("unknown"),
            requester_address = requester.ip_address.as_deref().unwrap_or("unknown"),
            requester_session = requester.session_id_prefix.as_deref().unwrap_or("none"),
            server_version = %self.server_version,
            target_version = snapshot.target_version.as_deref().or(snapshot.latest_version.as_deref()).unwrap_or("unknown"),
            "remote update install requested"
        );
        if snapshot.state == RemoteUpdateState::Error {
            tracing::warn!(
                requester_label = requester.label.as_deref().unwrap_or("unknown"),
                requester_session = requester.session_id_prefix.as_deref().unwrap_or("none"),
                error = snapshot.error.as_deref().unwrap_or(""),
                "remote update install request failed"
            );
        }
        Ok(snapshot)
    }
```

- `rpc/session.rs` (`impl RpcSessionContext`):

```rust
    /// The paired-client metadata of this connection's session, for audit and host
    /// notices. `None` on an unauthenticated server or for an unknown session.
    pub(crate) async fn current_client_metadata(&self) -> Option<ClientMetadata> {
        let (Some(principal), Some(auth)) = (&self.principal, &self.auth) else {
            return None;
        };
        auth.list_clients(&principal.session_id)
            .await
            .into_iter()
            .find(|client| client.current)
            .map(|client| client.client)
    }
```

  (import `crate::auth::model::ClientMetadata` or the path `list_clients` returns; `ClientSessionView.client` is a `ClientMetadata`).
- `production/remote_update_rpc.rs`, replace the `updater.install` registration:

```rust
    registry.register_unary_with_context("updater.install", move |_request, context, _cancellation| {
        let service = service.clone();
        async move {
            let metadata = context.current_client_metadata().await;
            let requester = RemoteUpdateRequester {
                label: metadata.as_ref().and_then(|client| client.label.clone()),
                os: metadata.as_ref().and_then(|client| client.os.clone()),
                ip_address: metadata.as_ref().and_then(|client| client.ip_address.clone()),
                session_id_prefix: context
                    .current_session_id()
                    .map(|id| id.chars().take(8).collect()),
            };
            service
                .install(requester)
                .await
                .map(|snapshot| serde_json::to_value(snapshot).expect("snapshot serializes"))
        }
    });
```

- `lib.rs`: add `RemoteUpdateRequester` and `RemoteUpdateInstallKind` to the `pub use remote_update::{…}` list.
- `remote_update_delegate.rs`: `fn request_install(&self, _requester: RemoteUpdateRequester) -> HostUpdaterFuture` (body unchanged until Task 8).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p bibcode-server --lib remote_update && cargo test -p bibcode-server --test remote_update_rpc && cargo test -p bibcode-desktop --lib remote_update_delegate`
Expected: PASS.

- [ ] **Step 5: Lint**

Run: `cargo fmt --all --check && cargo clippy -p bibcode-server --all-targets -- -D warnings && cargo clippy -p bibcode-desktop --all-targets -- -D warnings`
Expected: clean.

- [ ] **Step 6: Stop: the controller runs a Codex review and asks the user before committing.**

## Phase D — The desktop delegate (decisions 2 and 4)

### Task 8: Map percent, stage and target; keep the requester as `requestedBy`

**Files:**
- Modify: `apps/desktop/src-tauri/src/remote_update_delegate.rs` (`map_desktop_update_state`, `request_install`, `run_remote_install`, tests)
- Modify: `apps/desktop/src-tauri/src/updates.rs` (`DesktopUpdateInner.requested_by`, `RemoteUpdateRequest`, `begin_remote_request`, `clear_remote_request`, `update_state_value`, `disabled_update_state`, `clone_without_updates`, `restore_visible_state`, tests)
- Modify: `packages/contracts/src/ipc.ts` (`DesktopUpdateState` interface and `DesktopUpdateStateSchema` only), `packages/contracts/src/ipc.test.ts`
- Modify: `apps/web/src/tauriDesktopBridge.ts` (`defaultUpdateState`), `apps/web/src/tauriDesktopBridge.test.ts` if it pins the default

**Interfaces:**
- Consumes: `RemoteUpdateRequester` (Task 7), `HostUpdaterStatus` new fields (Task 4).
- Produces:
  - `updates.rs`: `#[derive(Clone, Debug, Eq, PartialEq, Serialize)] #[serde(rename_all = "camelCase")] pub(crate) struct RemoteUpdateRequest { pub label: String, pub detail: Option<String> }`.
  - `DesktopUpdateManager::begin_remote_request(&self, app, request: RemoteUpdateRequest) -> bool` — `true` and emits when no remote request is recorded; `false` (joins, emits nothing) otherwise.
  - `DesktopUpdateManager::clear_remote_request(&self, app)` — clears and emits.
  - `update_state_value` serializes `"requestedBy": null | {label, detail}`.
  - `pub(crate) fn remote_update_request(requester: &RemoteUpdateRequester) -> RemoteUpdateRequest` in `remote_update_delegate.rs`: label = requester label or `"Another device"`; detail = `"{os} ({address})"`, `"{os}"`, `"{address}"`, or `None`.
  - TypeScript: `DesktopUpdateState.requestedBy: { label: string; detail: string | null } | null` (schema decode default `null`).

- [ ] **Step 1: Write the failing Rust tests**

In `remote_update_delegate.rs` `mod tests`, extend `maps_every_desktop_updater_state_onto_the_wire_contract` with:

```rust
        let downloading = map_desktop_update_state(&json!({
            "status": "downloading", "phase": "available",
            "availableVersion": "0.6.4", "downloadPercent": 42.7
        }));
        assert_eq!(downloading.download_percent, Some(42));
        assert_eq!(downloading.target_version.as_deref(), Some("0.6.4"));
        assert_eq!(downloading.install_stage, None);

        let downloaded = map_desktop_update_state(&json!({
            "status": "downloaded", "phase": "available",
            "availableVersion": "0.6.4", "downloadedVersion": "0.6.4", "downloadPercent": 100.0
        }));
        assert_eq!(downloaded.download_percent, None, "percent only while downloading");
        assert_eq!(downloaded.target_version.as_deref(), Some("0.6.4"));

        let protecting = map_desktop_update_state(&json!({
            "status": "downloaded", "phase": "protecting", "downloadedVersion": "0.6.4",
            "protection": [
                {"environmentId": "primary", "status": "protected", "stage": "stopping-backend"},
                {"environmentId": "wsl:Ubuntu", "status": "pending", "stage": "creating-verified-backup"}
            ]
        }));
        assert_eq!(protecting.install_stage.as_deref(), Some("creating-verified-backup"));

        let installing = map_desktop_update_state(&json!({
            "status": "downloaded", "phase": "installing", "downloadedVersion": "0.6.4",
            "protection": []
        }));
        assert_eq!(installing.install_stage.as_deref(), Some("installing"));
```

Add:

```rust
    #[test]
    fn requester_becomes_a_host_notice_with_a_generic_fallback() {
        let full = remote_update_request(&RemoteUpdateRequester {
            label: Some("BiBCode Desktop".to_owned()),
            os: Some("MacIntel".to_owned()),
            ip_address: Some("192.168.1.34".to_owned()),
            session_id_prefix: Some("0123abcd".to_owned()),
        });
        assert_eq!(full.label, "BiBCode Desktop");
        assert_eq!(full.detail.as_deref(), Some("MacIntel (192.168.1.34)"));

        let os_only = remote_update_request(&RemoteUpdateRequester {
            label: Some("BiBCode Web".to_owned()),
            os: Some("Linux x86_64".to_owned()),
            ..RemoteUpdateRequester::default()
        });
        assert_eq!(os_only.detail.as_deref(), Some("Linux x86_64"));

        let unknown = remote_update_request(&RemoteUpdateRequester::default());
        assert_eq!(unknown.label, "Another device");
        assert_eq!(unknown.detail, None);
    }

    /// A feed that answers "nothing newer" only when the test says so, so the test
    /// can observe the flow while it is still running.
    fn spawn_gated_no_update_feed() -> (String, std::sync::mpsc::Sender<()>, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("update feed should bind");
        let base_url = format!("http://{}", listener.local_addr().expect("feed address"));
        let (release, released) = std::sync::mpsc::channel::<()>();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("feed request should arrive");
            let mut request = [0_u8; 2048];
            let _ = stream.read(&mut request).expect("feed request should read");
            released.recv().expect("the test releases the feed");
            stream
                .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
                .expect("feed response should write");
        });
        (base_url, release, server)
    }

    #[tokio::test]
    async fn a_remote_request_is_recorded_once_and_cleared_when_the_flow_ends() {
        let (base_url, release, feed) = spawn_gated_no_update_feed();
        let app = host_app(format!("{base_url}/latest.json"));
        let delegate = DesktopRemoteUpdateDelegate::new(app.handle().clone());
        let manager = app.state::<DesktopUpdateManager>();
        let requester = RemoteUpdateRequester {
            label: Some("Tablet".to_owned()),
            ..RemoteUpdateRequester::default()
        };

        delegate.request_install(requester.clone()).await;
        assert_eq!(
            manager.state(app.handle())["requestedBy"]["label"],
            "Tablet",
            "the host window sees who asked while the flow runs"
        );
        // A second client joining the running install adds no second notice.
        assert!(!manager.begin_remote_request(
            app.handle(),
            remote_update_request(&requester)
        ));

        release.send(()).expect("release the feed");
        let settled = settled_status(&delegate).await;
        assert_eq!(settled.state, RemoteUpdateState::UpToDate);
        tokio::time::timeout(Duration::from_secs(1), async {
            while manager.state(app.handle())["requestedBy"] != Value::Null {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("the request clears when the flow ends");
        feed.join().expect("update feed should stop");
    }
```

The gated feed holds the check open, so the recorded request and the joining client's `false` are observed while the flow runs; the clear is polled because `run_remote_install` returns on Tauri's runtime just after the state settles.

- [ ] **Step 2: Write the failing contract test**

In `packages/contracts/src/ipc.test.ts`, next to the existing `DesktopUpdateStateSchema` cases (copy one full state object from there):

```ts
  it("defaults requestedBy for an older desktop host and decodes a remote request", () => {
    const decode = Schema.decodeUnknownSync(DesktopUpdateStateSchema);
    expect(decode(baseUpdateState).requestedBy).toBeNull();
    expect(
      decode({
        ...baseUpdateState,
        requestedBy: { label: "BiBCode Desktop", detail: "MacIntel (192.168.1.34)" },
      }).requestedBy,
    ).toEqual({ label: "BiBCode Desktop", detail: "MacIntel (192.168.1.34)" });
  });
```

(`baseUpdateState` is whatever full `DesktopUpdateState` fixture the file already defines; name it accordingly.)

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test -p bibcode-desktop --lib remote_update_delegate`
Expected: FAIL/compile errors (`remote_update_request`, `begin_remote_request` missing; `download_percent` is `None`).

Run: `vp test run packages/contracts/src/ipc.test.ts`
Expected: FAIL (`requestedBy` is `undefined`).

- [ ] **Step 4: Implement the desktop side**

`updates.rs`:
- Add `RemoteUpdateRequest` (Interfaces) and `requested_by: Option<RemoteUpdateRequest>,` to `DesktopUpdateInner`; copy it in `clone_without_updates` and `restore_visible_state`.
- `update_state_value` adds `"requestedBy": inner.requested_by,`; `disabled_update_state` and `error_update_state` add `"requestedBy": null`.
- On `DesktopUpdateManager`:

```rust
    /// Records who asked for a remote install. Returns false when an install a remote
    /// client asked for is already running, so a joining client adds no second notice.
    pub(crate) fn begin_remote_request<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        request: RemoteUpdateRequest,
    ) -> bool {
        let state = {
            let mut inner = self.inner.lock().expect("desktop update mutex poisoned");
            if inner.requested_by.is_some() {
                return false;
            }
            inner.requested_by = Some(request);
            inner.clone_without_updates()
        };
        state.emit(app);
        true
    }

    pub(crate) fn clear_remote_request<R: Runtime>(&self, app: &AppHandle<R>) {
        self.replace_inner(|inner| inner.requested_by = None).emit(app);
    }
```

`remote_update_delegate.rs`:

```rust
#[must_use]
pub(crate) fn remote_update_request(requester: &RemoteUpdateRequester) -> RemoteUpdateRequest {
    let detail = match (requester.os.as_deref(), requester.ip_address.as_deref()) {
        (Some(os), Some(address)) => Some(format!("{os} ({address})")),
        (Some(os), None) => Some(os.to_owned()),
        (None, Some(address)) => Some(address.to_owned()),
        (None, None) => None,
    };
    RemoteUpdateRequest {
        label: requester
            .label
            .clone()
            .unwrap_or_else(|| "Another device".to_owned()),
        detail,
    }
}
```

`map_desktop_update_state` fills the new fields:

```rust
    let target_version = state["downloadedVersion"]
        .as_str()
        .or_else(|| state["availableVersion"].as_str())
        .map(str::to_owned);
    let download_percent = (mapped == RemoteUpdateState::Downloading)
        .then(|| state["downloadPercent"].as_f64())
        .flatten()
        .map(|percent| percent.clamp(0.0, 100.0).floor() as u8);
    let install_stage = match phase {
        "installing" => Some("installing".to_owned()),
        "protecting" => state["protection"].as_array().and_then(|entries| {
            entries
                .iter()
                .find(|entry| entry["status"] == "pending")
                .and_then(|entry| entry["stage"].as_str())
                .map(str::to_owned)
        }),
        _ => None,
    };
```

(If clippy rejects the `as u8` cast, use `u8::try_from(percent.clamp(0.0, 100.0).floor() as u32).unwrap_or(100)` or an explicit `#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]` on a two-line helper with a comment that the value is clamped.)

`request_install` records the requester and starts the flow only for the first request:

```rust
    fn request_install(&self, requester: RemoteUpdateRequester) -> HostUpdaterFuture {
        let app = self.app.clone();
        Box::pin(async move {
            let updates = app.state::<DesktopUpdateManager>();
            if updates.begin_remote_request(&app, remote_update_request(&requester)) {
                tauri::async_runtime::spawn(run_remote_install(app.clone(), requester));
            }
            map_desktop_update_state(&updates.state(&app))
        })
    }
```

`run_remote_install(app, requester)` clears the request on every return path with a guard, and adds the requester to its existing `warn!` lines (`requester_label`, `requester_session`):

```rust
struct RemoteRequestGuard<R: Runtime>(AppHandle<R>);

impl<R: Runtime> Drop for RemoteRequestGuard<R> {
    fn drop(&mut self) {
        self.0.state::<DesktopUpdateManager>().clear_remote_request(&self.0);
    }
}
```

Create `let _request = RemoteRequestGuard(app.clone());` at the top of `run_remote_install`. A successful Linux/macOS install restarts the process inside `install_update`, so the guard never runs there; on Windows the NSIS installer relaunches the app.

- [ ] **Step 5: Implement the contract and the bridge default**

`packages/contracts/src/ipc.ts` (targeted edit of the two `DesktopUpdateState` definitions only):

```ts
export interface DesktopUpdateRequester {
  readonly label: string;
  readonly detail: string | null;
}
// in interface DesktopUpdateState:
  requestedBy?: DesktopUpdateRequester | null;
// in DesktopUpdateStateSchema:
  requestedBy: Schema.NullOr(
    Schema.Struct({ label: Schema.String, detail: Schema.NullOr(Schema.String) }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
```

`apps/web/src/tauriDesktopBridge.ts::defaultUpdateState` returns `requestedBy: null`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cargo test -p bibcode-desktop --lib remote_update_delegate updates::tests`
Run: `vp test run packages/contracts/src/ipc.test.ts apps/web/src/tauriDesktopBridge.test.ts`
Expected: PASS.

- [ ] **Step 7: Lint and typecheck**

Run: `cargo fmt --all --check && cargo clippy -p bibcode-desktop --all-targets -- -D warnings && vp run typecheck`
Expected: clean.

- [ ] **Step 8: Stop: the controller runs a Codex review and asks the user before committing.**

## Phase E — The client coordinator (decision 3)

### Task 9: Coordinator core: install, follow the restart, decide the outcome

**Files:**
- Create: `packages/client-runtime/src/state/remoteUpdateCoordinator.ts`
- Create: `packages/client-runtime/src/state/remoteUpdateCoordinator.test.ts`
- Modify: `packages/client-runtime/package.json` — add a `"./state/remoteUpdateCoordinator"` entry (`types` and `default` → `./src/state/remoteUpdateCoordinator.ts`) next to `"./state/remoteUpdates"`; the exports map is explicit

**Interfaces:**
- Consumes: `RemoteUpdateSnapshot`, `RemoteUpdateInstallError` (`@bibcode/contracts`), `compareSemverVersions` (`@bibcode/shared/semver`).
- Produces:

```ts
export interface RemoteUpdateConnectionView {
  readonly connected: boolean;
  readonly generation: number;
}
export interface RemoteUpdateServerIdentity {
  readonly bootId: string | null;
  readonly serverVersion: string;
  /** `capabilities.remoteUpdateProgress`: bootId, percent, stages and counts are reported. */
  readonly progress: boolean;
}
export interface RemoteUpdatePort {
  /** The latest supervisor state for the environment (fed from `stateChanges`). */
  readonly connection: Effect.Effect<RemoteUpdateConnectionView>;
  /** `server.getConfig` on the live connection. */
  readonly identity: Effect.Effect<RemoteUpdateServerIdentity, unknown>;
  readonly status: Effect.Effect<RemoteUpdateSnapshot, unknown>;
  readonly install: Effect.Effect<RemoteUpdateSnapshot, unknown>;
  readonly retryNow: Effect.Effect<void>;
}
export type RemoteUpdateFailure =
  | { readonly kind: "host-error"; readonly message: string; readonly runningVersion: string }
  | { readonly kind: "not-back" }
  | { readonly kind: "wrong-version"; readonly runningVersion: string; readonly targetVersion: string }
  | { readonly kind: "manual-required" };
export type RemoteUpdateRunState =
  | { readonly phase: "queued" }
  | { readonly phase: "starting" }
  | { readonly phase: "downloading"; readonly percent: number | null; readonly targetVersion: string | null }
  | { readonly phase: "installing"; readonly stage: string | null; readonly targetVersion: string | null }
  | { readonly phase: "restarting"; readonly targetVersion: string | null }
  | { readonly phase: "verifying"; readonly targetVersion: string | null }
  | { readonly phase: "succeeded"; readonly version: string }
  | { readonly phase: "up-to-date" }
  | { readonly phase: "failed"; readonly failure: RemoteUpdateFailure };
export const isRemoteUpdateRunActive: (state: RemoteUpdateRunState | null) => boolean;
export const runRemoteUpdate: (
  port: RemoteUpdatePort,
  publish: (state: RemoteUpdateRunState) => Effect.Effect<void>,
) => Effect.Effect<RemoteUpdateRunState>;
// Timing constants (exported for tests and docs):
// REMOTE_UPDATE_POLL_MS = 1_000, REMOTE_UPDATE_READ_TIMEOUT_MS = 10_000,
// REMOTE_UPDATE_INSTALL_TIMEOUT_MS = 30_000, REMOTE_UPDATE_DOWNLOAD_BUDGET_MS = 600_000,
// REMOTE_UPDATE_INSTALL_BUDGET_MS = 120_000, REMOTE_UPDATE_RESTART_BUDGET_MS = 180_000,
// REMOTE_UPDATE_RETRY_INTERVAL_MS = 5_000
```

`runRemoteUpdate` never fails: every outcome is a terminal `RemoteUpdateRunState` (also published). Read `.repos/effect-smol/LLMS.md` before writing the Effect code (AGENTS.md rule).

- [ ] **Step 1: Write the failing tests**

Create `packages/client-runtime/src/state/remoteUpdateCoordinator.test.ts`:

```ts
import { describe, expect, it } from "@effect/vitest";
import {
  REMOTE_UPDATE_MANUAL_REQUIRED,
  RemoteUpdateInstallError,
  type RemoteUpdateSnapshot,
} from "@bibcode/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import {
  REMOTE_UPDATE_RESTART_BUDGET_MS,
  type RemoteUpdateConnectionView,
  type RemoteUpdatePort,
  type RemoteUpdateRunState,
  type RemoteUpdateServerIdentity,
  runRemoteUpdate,
} from "./remoteUpdateCoordinator.ts";

const snapshot = (overrides: Partial<RemoteUpdateSnapshot> = {}): RemoteUpdateSnapshot => ({
  serverVersion: "0.6.2",
  latestVersion: "0.6.4",
  state: "update-available",
  error: null,
  support: { installMode: "interactive", reason: "available", installKind: "unknown" },
  downloadPercent: null,
  targetVersion: "0.6.4",
  installStage: null,
  ...overrides,
});

const OLD_BOOT: RemoteUpdateServerIdentity = { bootId: "boot-1", serverVersion: "0.6.2", progress: true };

const makeFakeHost = Effect.fn("TestRemoteUpdate.makeFakeHost")(function* (options: {
  readonly install?: Effect.Effect<RemoteUpdateSnapshot, unknown>;
  readonly identity?: RemoteUpdateServerIdentity;
} = {}) {
  const connection = yield* Ref.make<RemoteUpdateConnectionView>({ connected: true, generation: 1 });
  const identity = yield* Ref.make<RemoteUpdateServerIdentity>(options.identity ?? OLD_BOOT);
  const status = yield* Ref.make<RemoteUpdateSnapshot>(snapshot({ state: "downloading", downloadPercent: 0 }));
  const retries = yield* Ref.make(0);
  const published = yield* Ref.make<ReadonlyArray<RemoteUpdateRunState>>([]);
  const port: RemoteUpdatePort = {
    connection: Ref.get(connection),
    identity: Ref.get(identity),
    status: Ref.get(status),
    install: options.install ?? Ref.get(status),
    retryNow: Ref.update(retries, (count) => count + 1),
  };
  const run = yield* runRemoteUpdate(port, (state) =>
    Ref.update(published, (states) => [...states, state]),
  ).pipe(Effect.forkChild({ startImmediately: true }));
  const phases = Ref.get(published).pipe(Effect.map((states) => states.map((state) => state.phase)));
  /** The host restarts: the socket drops, then a new boot answers. */
  const restart = (next: RemoteUpdateServerIdentity, after: string) =>
    Effect.gen(function* () {
      yield* Ref.update(connection, (view) => ({ connected: false, generation: view.generation }));
      yield* TestClock.adjust(after);
      yield* Ref.set(identity, next);
      yield* Ref.update(connection, (view) => ({ connected: true, generation: view.generation + 1 }));
    });
  return { connection, identity, status, retries, published, run, phases, restart };
});

describe("runRemoteUpdate", () => {
  it.effect("follows download, backup and restart to a new boot on the target version", () =>
    Effect.gen(function* () {
      const host = yield* makeFakeHost();
      yield* Ref.set(host.status, snapshot({ state: "downloading", downloadPercent: 42 }));
      yield* TestClock.adjust("1 second");
      yield* Ref.set(
        host.status,
        snapshot({ state: "installing", installStage: "creating-verified-backup" }),
      );
      yield* TestClock.adjust("1 second");
      yield* host.restart({ bootId: "boot-2", serverVersion: "0.6.4", progress: true }, "20 seconds");
      yield* TestClock.adjust("1 second");

      const outcome = yield* Fiber.join(host.run);
      expect(outcome).toEqual({ phase: "succeeded", version: "0.6.4" });
      const states = yield* Ref.get(host.published);
      expect(states).toContainEqual({ phase: "downloading", percent: 42, targetVersion: "0.6.4" });
      expect(states).toContainEqual({
        phase: "installing",
        stage: "creating-verified-backup",
        targetVersion: "0.6.4",
      });
      expect(yield* host.phases).toEqual(
        expect.arrayContaining(["starting", "restarting", "verifying", "succeeded"]),
      );
    }),
  );

  it.effect("ends with the host's error while the old boot still answers", () =>
    Effect.gen(function* () {
      const host = yield* makeFakeHost();
      yield* Ref.set(host.status, snapshot({ state: "error", error: "Signature mismatch" }));
      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(host.run)).toEqual({
        phase: "failed",
        failure: { kind: "host-error", message: "Signature mismatch", runningVersion: "0.6.2" },
      });
    }),
  );

  it.effect("reports the host's error from a new boot on the old version", () =>
    Effect.gen(function* () {
      const host = yield* makeFakeHost();
      yield* Ref.set(host.status, snapshot({ state: "installing", installStage: "creating-verified-backup" }));
      yield* TestClock.adjust("1 second");
      yield* Ref.set(host.status, snapshot({ state: "error", error: "Verified backup timed out" }));
      yield* host.restart({ bootId: "boot-2", serverVersion: "0.6.2", progress: true }, "10 seconds");
      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(host.run)).toEqual({
        phase: "failed",
        failure: { kind: "host-error", message: "Verified backup timed out", runningVersion: "0.6.2" },
      });
    }),
  );

  it.effect("fails as restarted on the old version when a new boot has no error", () =>
    Effect.gen(function* () {
      const host = yield* makeFakeHost();
      yield* TestClock.adjust("1 second");
      yield* Ref.set(host.status, snapshot({ state: "idle" }));
      yield* host.restart({ bootId: "boot-2", serverVersion: "0.6.2", progress: true }, "10 seconds");
      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(host.run)).toEqual({
        phase: "failed",
        failure: { kind: "wrong-version", runningVersion: "0.6.2", targetVersion: "0.6.4" },
      });
    }),
  );

  it.effect("gives up when the host has not come back within the restart budget", () =>
    Effect.gen(function* () {
      const host = yield* makeFakeHost();
      yield* TestClock.adjust("1 second");
      yield* Ref.update(host.connection, (view) => ({ ...view, connected: false }));
      yield* TestClock.adjust(REMOTE_UPDATE_RESTART_BUDGET_MS + 2_000);
      expect(yield* Fiber.join(host.run)).toEqual({
        phase: "failed",
        failure: { kind: "not-back" },
      });
    }),
  );

  it.effect("asks the supervisor to retry at most every five seconds while waiting", () =>
    Effect.gen(function* () {
      const host = yield* makeFakeHost();
      yield* TestClock.adjust("1 second");
      yield* Ref.update(host.connection, (view) => ({ ...view, connected: false }));
      yield* TestClock.adjust("60 seconds");
      const retries = yield* Ref.get(host.retries);
      expect(retries).toBeGreaterThanOrEqual(11);
      expect(retries).toBeLessThanOrEqual(13);
      yield* Fiber.interrupt(host.run);
    }),
  );

  it.effect("keeps waiting when the same boot answers again after a network blip", () =>
    Effect.gen(function* () {
      const host = yield* makeFakeHost();
      yield* Ref.set(host.status, snapshot({ state: "downloading", downloadPercent: 10 }));
      yield* host.restart(OLD_BOOT, "3 seconds");
      yield* TestClock.adjust("2 seconds");
      yield* Ref.set(host.status, snapshot({ state: "downloading", downloadPercent: 60 }));
      yield* TestClock.adjust("1 second");
      const states = yield* Ref.get(host.published);
      expect(states.at(-1)).toEqual({ phase: "downloading", percent: 60, targetVersion: "0.6.4" });
      yield* Fiber.interrupt(host.run);
    }),
  );

  it.effect("ends as already up to date", () =>
    Effect.gen(function* () {
      const host = yield* makeFakeHost({
        install: Effect.succeed(snapshot({ state: "up-to-date", latestVersion: null, targetVersion: null })),
      });
      expect(yield* Fiber.join(host.run)).toEqual({ phase: "up-to-date" });
    }),
  );

  it.effect("refuses a manual host with the typed install error", () =>
    Effect.gen(function* () {
      const host = yield* makeFakeHost({
        install: Effect.fail(new RemoteUpdateInstallError({ code: REMOTE_UPDATE_MANUAL_REQUIRED })),
      });
      expect(yield* Fiber.join(host.run)).toEqual({
        phase: "failed",
        failure: { kind: "manual-required" },
      });
    }),
  );

  it.effect("decides by version alone, with no percent or stage, without the capability", () =>
    Effect.gen(function* () {
      const legacy: RemoteUpdateServerIdentity = { bootId: null, serverVersion: "0.6.2", progress: false };
      const host = yield* makeFakeHost({ identity: legacy });
      yield* Ref.set(host.status, snapshot({ state: "downloading", downloadPercent: 42 }));
      yield* TestClock.adjust("1 second");
      yield* host.restart({ bootId: null, serverVersion: "0.6.4", progress: false }, "10 seconds");
      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(host.run)).toEqual({ phase: "succeeded", version: "0.6.4" });
      const states = yield* Ref.get(host.published);
      expect(states).toContainEqual({ phase: "downloading", percent: null, targetVersion: "0.6.4" });
    }),
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `vp test run packages/client-runtime/src/state/remoteUpdateCoordinator.test.ts`
Expected: FAIL — cannot resolve `./remoteUpdateCoordinator.ts`.

- [ ] **Step 3: Implement**

Create `packages/client-runtime/src/state/remoteUpdateCoordinator.ts`:

```ts
import {
  REMOTE_UPDATE_MANUAL_REQUIRED,
  RemoteUpdateInstallError,
  type RemoteUpdateSnapshot,
} from "@bibcode/contracts";
import { compareSemverVersions } from "@bibcode/shared/semver";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// (interfaces and types exactly as listed under Interfaces)

export const REMOTE_UPDATE_POLL_MS = 1_000;
export const REMOTE_UPDATE_READ_TIMEOUT_MS = 10_000;
export const REMOTE_UPDATE_INSTALL_TIMEOUT_MS = 30_000;
export const REMOTE_UPDATE_DOWNLOAD_BUDGET_MS = 10 * 60_000;
/** 30 s drain, 45 s prepare, 10 s commit, plus stopping and the installer. */
export const REMOTE_UPDATE_INSTALL_BUDGET_MS = 2 * 60_000;
export const REMOTE_UPDATE_RESTART_BUDGET_MS = 3 * 60_000;
export const REMOTE_UPDATE_RETRY_INTERVAL_MS = 5_000;

const isInstallError = Schema.is(RemoteUpdateInstallError);

export function isRemoteUpdateRunActive(state: RemoteUpdateRunState | null): boolean {
  switch (state?.phase) {
    case "queued":
    case "starting":
    case "downloading":
    case "installing":
    case "restarting":
    case "verifying":
      return true;
    default:
      return false;
  }
}

const atLeast = (version: string, target: string) => compareSemverVersions(version, target) >= 0;

type Verdict =
  | { readonly kind: "done"; readonly state: RemoteUpdateRunState }
  | { readonly kind: "same-boot"; readonly snapshot: RemoteUpdateSnapshot | null }
  | { readonly kind: "pending" };

export const runRemoteUpdate = Effect.fn("RemoteUpdate.run")(function* (
  port: RemoteUpdatePort,
  publish: (state: RemoteUpdateRunState) => Effect.Effect<void>,
) {
  const finish = (state: RemoteUpdateRunState) => publish(state).pipe(Effect.as(state));
  const hostError = (message: string, runningVersion: string) =>
    finish({ phase: "failed", failure: { kind: "host-error", message, runningVersion } });
  /** Each read is capped at 10 s and whatever is left of the current budget. */
  const read = <A>(effect: Effect.Effect<A, unknown>, deadline: number) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const budget = Math.max(1, Math.min(REMOTE_UPDATE_READ_TIMEOUT_MS, deadline - now));
      const exit = yield* Effect.exit(effect.pipe(Effect.timeout(budget)));
      return Exit.isSuccess(exit) ? exit.value : null;
    });

  yield* publish({ phase: "starting" });
  const startedAt = yield* Clock.currentTimeMillis;
  const before = yield* read(port.identity, startedAt + REMOTE_UPDATE_READ_TIMEOUT_MS);
  if (before === null) {
    return yield* hostError("the server did not answer before the update started", "unknown");
  }
  const progress = before.progress && before.bootId !== null;
  let generation = (yield* port.connection).generation;

  const installExit = yield* Effect.exit(
    port.install.pipe(Effect.timeout(REMOTE_UPDATE_INSTALL_TIMEOUT_MS)),
  );
  if (Exit.isFailure(installExit)) {
    const error = Option.getOrNull(Exit.findErrorOption(installExit));
    return isInstallError(error) && error.code === REMOTE_UPDATE_MANUAL_REQUIRED
      ? yield* finish({ phase: "failed", failure: { kind: "manual-required" } })
      : yield* hostError("the install request was not accepted", before.serverVersion);
  }
  let target = installExit.value.targetVersion ?? installExit.value.latestVersion;
  if (installExit.value.state === "up-to-date") return yield* finish({ phase: "up-to-date" });
  if (installExit.value.state === "error") {
    return yield* hostError(
      installExit.value.error ?? "the host's updater reported an error",
      before.serverVersion,
    );
  }

  const verify = Effect.fn("RemoteUpdate.verify")(function* (deadline: number) {
    const after = yield* read(port.identity, deadline);
    if (after === null) return { kind: "pending" } as Verdict;
    const newBoot = progress && after.bootId !== null && after.bootId !== before.bootId;
    const reachedTarget = target !== null && atLeast(after.serverVersion, target);
    if (reachedTarget && (newBoot || !progress)) {
      return { kind: "done", state: { phase: "succeeded", version: after.serverVersion } } as Verdict;
    }
    const status = yield* read(port.status, deadline);
    if (status?.state === "error") {
      return {
        kind: "done",
        state: {
          phase: "failed",
          failure: {
            kind: "host-error",
            message: status.error ?? "the host's updater reported an error",
            runningVersion: after.serverVersion,
          },
        },
      } as Verdict;
    }
    if (newBoot) {
      return {
        kind: "done",
        state: {
          phase: "failed",
          failure: {
            kind: "wrong-version",
            runningVersion: after.serverVersion,
            targetVersion: target ?? after.serverVersion,
          },
        },
      } as Verdict;
    }
    // The same boot answered again (a network blip), or a legacy host we cannot tell
    // apart: go back to following its progress.
    return { kind: "same-boot", snapshot: status } as Verdict;
  });

  // Follow the host while the old boot answers; return on disconnect or an outcome.
  let stageDeadline = startedAt + REMOTE_UPDATE_DOWNLOAD_BUDGET_MS;
  let installing = false;
  const follow = Effect.fn("RemoteUpdate.follow")(function* (initial: RemoteUpdateSnapshot | null) {
    let pending = initial;
    while (true) {
      const snapshot = pending ?? (yield* read(port.status, stageDeadline));
      pending = null;
      if (snapshot !== null) {
        target = snapshot.targetVersion ?? target;
        switch (snapshot.state) {
          case "downloading":
            yield* publish({
              phase: "downloading",
              percent: progress ? snapshot.downloadPercent : null,
              targetVersion: target,
            });
            break;
          case "installing":
            if (!installing) {
              installing = true;
              stageDeadline = (yield* Clock.currentTimeMillis) + REMOTE_UPDATE_INSTALL_BUDGET_MS;
            }
            yield* publish({
              phase: "installing",
              stage: progress ? snapshot.installStage : null,
              targetVersion: target,
            });
            break;
          case "up-to-date":
            return { kind: "done", state: { phase: "up-to-date" } } as Verdict;
          case "error":
            return {
              kind: "done",
              state: {
                phase: "failed",
                failure: {
                  kind: "host-error",
                  message: snapshot.error ?? "the host's updater reported an error",
                  runningVersion: snapshot.serverVersion,
                },
              },
            } as Verdict;
          default:
            break; // idle, checking or update-available: the flow has not started yet
        }
      }
      if ((yield* Clock.currentTimeMillis) >= stageDeadline) {
        return {
          kind: "done",
          state: {
            phase: "failed",
            failure: {
              kind: "host-error",
              message: installing
                ? "the install did not finish in 2 minutes"
                : "the download did not finish in 10 minutes",
              runningVersion: before.serverVersion,
            },
          },
        } as Verdict;
      }
      yield* Effect.sleep(REMOTE_UPDATE_POLL_MS);
      const connection = yield* port.connection;
      if (!connection.connected || connection.generation !== generation) {
        return { kind: "pending" } as Verdict; // the socket dropped: restart phase
      }
    }
  });

  let resume: RemoteUpdateSnapshot | null = null;
  while (true) {
    const followed = yield* follow(resume);
    if (followed.kind === "done") return yield* finish(followed.state);

    // Restart phase: wait for a new connected generation within 3 minutes.
    yield* publish({ phase: "restarting", targetVersion: target });
    const restartDeadline = (yield* Clock.currentTimeMillis) + REMOTE_UPDATE_RESTART_BUDGET_MS;
    let lastRetry = Number.NEGATIVE_INFINITY;
    let verdict: Verdict = { kind: "pending" };
    while (verdict.kind === "pending") {
      const now = yield* Clock.currentTimeMillis;
      if (now >= restartDeadline) {
        return yield* finish({ phase: "failed", failure: { kind: "not-back" } });
      }
      const connection = yield* port.connection;
      if (connection.connected && connection.generation !== generation) {
        generation = connection.generation;
        yield* publish({ phase: "verifying", targetVersion: target });
        verdict = yield* verify(restartDeadline);
        if (verdict.kind === "pending") {
          yield* publish({ phase: "restarting", targetVersion: target });
        }
      } else if (!connection.connected && now - lastRetry >= REMOTE_UPDATE_RETRY_INTERVAL_MS) {
        lastRetry = now;
        yield* port.retryNow;
      }
      if (verdict.kind === "pending") yield* Effect.sleep(REMOTE_UPDATE_POLL_MS);
    }
    if (verdict.kind === "done") return yield* finish(verdict.state);
    resume = verdict.snapshot; // same boot: follow its progress again
  }
});
```

Notes for the implementer:
- `Exit.findErrorOption` (`.repos/effect-smol/packages/effect/src/Exit.ts`) returns the typed failure, if any. A `RemoteUpdateInstallError` with `code === REMOTE_UPDATE_MANUAL_REQUIRED` is `manual-required`; everything else (RPC error, timeout, lost connection) is `host-error` "the install request was not accepted".
- `Effect.fn` with a generator that `return`s a union may need an explicit return type annotation; keep `runRemoteUpdate` typed `Effect.Effect<RemoteUpdateRunState>` (no error, no requirements).
- The restart "same boot" branch returns to `follow` with the status it already read, so a host still downloading after a blip keeps its 10-minute budget.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `vp test run packages/client-runtime/src/state/remoteUpdateCoordinator.test.ts`
Expected: PASS (10 tests). If the retry-count test is off by one because of where the first retry lands, keep the bounds (≥ 11, ≤ 13 in 60 s) and adjust the loop, not the bounds.

- [ ] **Step 5: Typecheck**

Run: `vp run typecheck`
Expected: clean.

- [ ] **Step 6: Stop: the controller runs a Codex review and asks the user before committing.**

### Task 10: One run per environment, two at once, owned by the Atom runtime

**Files:**
- Modify: `packages/client-runtime/src/state/remoteUpdates.ts` (`createRemoteUpdateEnvironmentAtoms`)
- Modify: `packages/client-runtime/src/state/remoteUpdates.test.ts`

**Interfaces:**
- Consumes: `runRemoteUpdate`, `RemoteUpdatePort`, `RemoteUpdateRunState` (Task 9); `EnvironmentRegistry.{stateChanges, retryNow, run}`; `request` from `../rpc/client.ts`; `WS_METHODS.{serverGetConfig, updaterStatus, updaterInstall}`.
- Produces, on the object `createRemoteUpdateEnvironmentAtoms` returns:
  - `run: (environmentId: EnvironmentId) => Atom.Writable<RemoteUpdateRunState | null>` — kept alive; `null` before the first run.
  - `update: AtomCommand<{ environmentId: EnvironmentId; input: {} }, RemoteUpdateRunState, never>` — single-flight per environment; waits for one of `MAX_CONCURRENT_REMOTE_UPDATE_CHECKS` permits showing `{ phase: "queued" }`; never tied to a component (no abort signal).
  - `dismiss: (registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) => void` — sets a terminal run back to `null` (no-op while active).
  - `activeWork` (Task 11).

- [ ] **Step 1: Write the failing tests**

Add a harness to `remoteUpdates.test.ts` modelled on `makeRemoteUpdateCommandHarness` (same `EnvironmentRegistry.of({ run })` shape plus `stateChanges` and `retryNow`), whose session client answers `server.getConfig`, `updater.status` and `updater.install` from per-environment `Ref`s:

```ts
const makeUpdateHarness = Effect.fn("TestRemoteUpdates.makeUpdateHarness")(function* () {
  const clock = yield* TestClock.make({ warningDelay: "1 hour" });
  const atomRegistry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => atomRegistry.dispose()));
  const installs = new Map<EnvironmentId, number>();
  const gates = new Map<EnvironmentId, Deferred.Deferred<void>>();
  const gateFor = (id: EnvironmentId) =>
    gates.get(id) ?? (gates.set(id, Deferred.makeUnsafe<void>()), gates.get(id)!);
  const client = (environmentId: EnvironmentId) => ({
    [WS_METHODS.serverGetConfig]: () =>
      Effect.succeed({
        environment: {
          bootId: "boot-1",
          serverVersion: "0.6.2",
          capabilities: { remoteUpdateProgress: true },
        },
      }),
    [WS_METHODS.updaterInstall]: () =>
      Effect.sync(() => installs.set(environmentId, (installs.get(environmentId) ?? 0) + 1)).pipe(
        Effect.andThen(Deferred.await(gateFor(environmentId))),
        Effect.as(UP_TO_DATE_SNAPSHOT),
      ),
    [WS_METHODS.updaterStatus]: () => Effect.succeed(UP_TO_DATE_SNAPSHOT),
  });
  // run / stateChanges / retryNow as in makeRemoteUpdateCommandHarness, with
  // stateChanges emitting one connected state: { phase: "connected", generation: 1, … }.
  …
  return { atomRegistry, atoms: createRemoteUpdateEnvironmentAtoms(runtime), installs, release: (id: EnvironmentId) => Deferred.succeed(gateFor(id), undefined), clock };
});
```

`UP_TO_DATE_SNAPSHOT` is `CHECKED_SNAPSHOT` with `state: "up-to-date"` and the Task 4 fields. Then:

```ts
describe("remote update runs", () => {
  it.effect("runs at most two at once and shows a third as queued", () =>
    Effect.gen(function* () {
      const h = yield* makeUpdateHarness();
      const [a, b, c] = ["env-a", "env-b", "env-c"].map((id) => EnvironmentId.make(id));
      for (const environmentId of [a, b, c]) {
        void h.atoms.update.run(h.atomRegistry, { environmentId, input: {} });
      }
      yield* drainAtoms;
      expect(h.installs.get(a)).toBe(1);
      expect(h.installs.get(b)).toBe(1);
      expect(h.installs.get(c)).toBeUndefined();
      expect(h.atomRegistry.get(h.atoms.run(c))).toEqual({ phase: "queued" });

      yield* h.release(a);
      yield* drainAtoms;
      expect(h.atomRegistry.get(h.atoms.run(a))).toEqual({ phase: "up-to-date" });
      expect(h.installs.get(c)).toBe(1);
    }),
  );

  it.effect("joins a second request for the same environment instead of installing twice", () =>
    Effect.gen(function* () {
      const h = yield* makeUpdateHarness();
      const environmentId = EnvironmentId.make("env-a");
      const first = h.atoms.update.run(h.atomRegistry, { environmentId, input: {} });
      const second = h.atoms.update.run(h.atomRegistry, { environmentId, input: {} });
      yield* drainAtoms;
      expect(h.installs.get(environmentId)).toBe(1);
      yield* h.release(environmentId);
      expect(yield* Effect.promise(() => second)).toEqual(yield* Effect.promise(() => first));
    }),
  );

  it.effect("keeps running after the view that started it unmounts", () =>
    Effect.gen(function* () {
      const h = yield* makeUpdateHarness();
      const environmentId = EnvironmentId.make("env-a");
      const unmount = h.atomRegistry.mount(h.atoms.run(environmentId));
      void h.atoms.update.run(h.atomRegistry, { environmentId, input: {} });
      yield* drainAtoms;
      unmount();
      yield* h.release(environmentId);
      yield* drainAtoms;
      expect(h.atomRegistry.get(h.atoms.run(environmentId))).toEqual({ phase: "up-to-date" });
    }),
  );
});
```

Also add a regression for the seeded connection view (the harness's `state(environmentId)` returns the same connected generation 1 that `stateChanges` emits, and its status client returns `downloading` twice, then `up-to-date`):

```ts
  it.effect("never shows Restarting before the host actually disconnects", () =>
    Effect.gen(function* () {
      const h = yield* makeUpdateHarness({ statusSequence: ["downloading", "downloading", "up-to-date"] });
      const environmentId = EnvironmentId.make("env-a");
      const seen: Array<string> = [];
      const unmount = h.atomRegistry.subscribe(h.atoms.run(environmentId), (state) => {
        if (state !== null) seen.push(state.phase);
      });
      void h.atoms.update.run(h.atomRegistry, { environmentId, input: {} });
      yield* h.release(environmentId);
      for (let second = 0; second < 4; second += 1) {
        yield* TestClock.adjust("1 second");
        yield* drainAtoms;
      }
      expect(seen).not.toContain("restarting");
      expect(seen.at(-1)).toBe("up-to-date");
      unmount();
    }),
  );
```

(`drainAtoms` already exists in this test file; reuse it. Give `makeUpdateHarness` an optional `statusSequence` and make its install answer `downloading` for this case; adapt the harness to the real `EnvironmentRegistry` method signatures, including `state`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `vp test run packages/client-runtime/src/state/remoteUpdates.test.ts`
Expected: FAIL — `h.atoms.update` / `h.atoms.run` are undefined.

- [ ] **Step 3: Implement**

In `createRemoteUpdateEnvironmentAtoms`:

```ts
  const run = Atom.family((environmentId: EnvironmentId) =>
    Atom.make<RemoteUpdateRunState | null>(null).pipe(
      Atom.keepAlive,
      Atom.withLabel(`environment-data:remote-update:run:${environmentId}`),
    ),
  );
  // One semaphore for all environments: spec "at most two run at once".
  const permits = Semaphore.makeUnsafe(MAX_CONCURRENT_REMOTE_UPDATE_CHECKS);

  const registryPort = (environmentId: EnvironmentId) =>
    Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry;
      // Seed from the current state before following changes, so the run's first
      // `connection` read is the live generation, not a placeholder.
      const initial = yield* registry.state(environmentId).pipe(Effect.option);
      const latest = yield* Ref.make<RemoteUpdateConnectionView>(
        Option.match(initial, {
          onNone: () => ({ connected: false, generation: -1 }),
          onSome: (state) => ({ connected: state.phase === "connected", generation: state.generation }),
        }),
      );
      // Follow the supervisor through the restart; no RPC effect spans it.
      yield* registry.stateChanges(environmentId).pipe(
        Stream.runForEach((state) =>
          Ref.set(latest, { connected: state.phase === "connected", generation: state.generation }),
        ),
        Effect.forkScoped,
      );
      const port: RemoteUpdatePort = {
        connection: Ref.get(latest),
        identity: registry
          .run(environmentId, request(WS_METHODS.serverGetConfig, {}))
          .pipe(
            Effect.map((config) => ({
              bootId: config.environment.bootId,
              serverVersion: config.environment.serverVersion,
              progress: config.environment.capabilities.remoteUpdateProgress,
            })),
          ),
        status: registry.run(environmentId, request(WS_METHODS.updaterStatus, {})),
        install: registry.run(environmentId, request(WS_METHODS.updaterInstall, {})),
        retryNow: registry.retryNow(environmentId),
      };
      return port;
    });

  const update = createRuntimeCommand(runtime, {
    label: "environment-data:remote-update:update",
    concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
    execute: ({ environmentId }: { environmentId: EnvironmentId; input: {} }, registry) =>
      Effect.scoped(
        Effect.gen(function* () {
          const publish = (state: RemoteUpdateRunState) =>
            Effect.sync(() => registry.set(run(environmentId), state));
          yield* publish({ phase: "queued" });
          return yield* permits.withPermits(1)(
            Effect.gen(function* () {
              const port = yield* registryPort(environmentId);
              return yield* runRemoteUpdate(port, publish);
            }),
          );
        }),
      ),
  });

  const dismiss = (registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) => {
    if (!isRemoteUpdateRunActive(registry.get(run(environmentId)))) {
      registry.set(run(environmentId), null);
    }
  };
```

Return `run`, `update`, `dismiss` alongside the existing members; import `createRuntimeCommand` from `./runtime.ts`, `Semaphore`, `Ref`, `AtomRegistry`, and the coordinator exports. `Semaphore.makeUnsafe(n)`, `semaphore.withPermits(1)(effect)` and `Effect.forkScoped` are the `effect-smol` names (`.repos/effect-smol/packages/effect/src/{Semaphore,Effect}.ts`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `vp test run packages/client-runtime/src/state/remoteUpdates.test.ts packages/client-runtime/src/state/remoteUpdateCoordinator.test.ts`
Expected: PASS, including every existing badge-state test.

- [ ] **Step 5: Typecheck**

Run: `vp run typecheck`
Expected: clean.

- [ ] **Step 6: Stop: the controller runs a Codex review and asks the user before committing.**

### Task 11: `activeWork` query and web hooks

**Files:**
- Modify: `packages/client-runtime/src/state/remoteUpdates.ts` (add `activeWork`), `packages/client-runtime/src/state/remoteUpdates.test.ts`
- Modify: `apps/web/src/state/remoteUpdates.ts`

**Interfaces:**
- Produces:
  - `activeWork: createEnvironmentRpcQueryAtomFamily(runtime, { label: "environment-data:remote-update:active-work", tag: WS_METHODS.updaterActiveWork, staleTimeMs: 0 })` on the atoms object. Only the confirmation dialog observes it (spec: never polled with status).
  - Web: `export function useRemoteUpdateRun(environmentId: EnvironmentId | null): RemoteUpdateRunState | null`.

- [ ] **Step 1: Write the failing test**

In `remoteUpdates.test.ts`, extend `makeUpdateHarness`'s client with `[WS_METHODS.updaterActiveWork]: () => Effect.succeed({ runningTurns: 2, liveTerminals: 3, queuedMessages: 1 })` and add:

```ts
  it.effect("reads the active work once when a view asks for it", () =>
    Effect.gen(function* () {
      const h = yield* makeUpdateHarness();
      const atom = h.atoms.activeWork({ environmentId: EnvironmentId.make("env-a"), input: {} });
      const unmount = h.atomRegistry.mount(atom);
      yield* drainAtoms;
      const result = h.atomRegistry.get(atom);
      expect(AsyncResult.isSuccess(result) && result.value).toEqual({
        runningTurns: 2,
        liveTerminals: 3,
        queuedMessages: 1,
      });
      unmount();
    }),
  );
```

(The query runs only on a connected generation; the harness's `stateChanges` emits one.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `vp test run packages/client-runtime/src/state/remoteUpdates.test.ts`
Expected: FAIL — `h.atoms.activeWork` is not a function.

- [ ] **Step 3: Implement**

Add the `activeWork` member (Interfaces). In `apps/web/src/state/remoteUpdates.ts`:

```ts
const NO_RUN_ATOM = Atom.make<RemoteUpdateRunState | null>(null).pipe(
  Atom.withLabel("web-remote-update-run:none"),
);

/** The environment's update run, whichever view started it; null without one. */
export function useRemoteUpdateRun(environmentId: EnvironmentId | null): RemoteUpdateRunState | null {
  return useAtomValue(environmentId === null ? NO_RUN_ATOM : remoteUpdateEnvironment.run(environmentId));
}
```

(import `RemoteUpdateRunState` from `@bibcode/client-runtime/state/remoteUpdateCoordinator`, exported in Task 9).

- [ ] **Step 4: Run the tests and typecheck**

Run: `vp test run packages/client-runtime/src/state/remoteUpdates.test.ts && vp run typecheck`
Expected: PASS and clean.

- [ ] **Step 5: Stop: the controller runs a Codex review and asks the user before committing.**

## Phase F — The UI

Every task in this phase changes what a user sees. Each ends with the component checks listed in its steps; the `vercel-react-best-practices` and `UI.md` reviews and the live Playwright check run once for the whole phase in Tasks 20 and 21.

### Task 12: Update copy and the badge while a run is active

**Files:**
- Create: `apps/web/src/components/settings/remoteUpdatePresentation.ts`, `apps/web/src/components/settings/remoteUpdatePresentation.test.ts`
- Modify: `apps/web/src/components/settings/ServerUpdateBadge.tsx`, `apps/web/src/components/settings/ServerUpdateBadge.test.tsx`
- Modify: `apps/web/src/state/remoteUpdates.ts` (`useStartRemoteUpdate`)

**Interfaces:**
- Consumes: `RemoteUpdateRunState`, `RemoteUpdateFailure`, `isRemoteUpdateRunActive` (Task 9); `RemoteUpdateActiveWork` (Task 6); `remoteUpdateEnvironment.update` / `.run` (Tasks 10–11); `APP_VERSION` from `apps/web/src/branding.ts`; `compareSemverVersions`.
- Produces (`remoteUpdatePresentation.ts`):

```ts
export function remoteUpdateActionLabel(latestVersion: string): string; // "Update to v0.6.4…"
export interface RemoteUpdateConfirmationInput {
  readonly name: string;
  readonly targetVersion: string | null;
  /** null when the server cannot count (no capability) or the read failed. */
  readonly activeWork: RemoteUpdateActiveWork | null;
  readonly appVersion: string;
  /** The server being updated serves this browser page. */
  readonly servesThisPage: boolean;
}
export interface RemoteUpdateConfirmation {
  readonly title: string;
  readonly lines: ReadonlyArray<string>;
  readonly confirmLabel: string; // "Update {name}"
}
export function remoteUpdateConfirmation(input: RemoteUpdateConfirmationInput): RemoteUpdateConfirmation;
export function remoteUpdateProgressLabel(state: RemoteUpdateRunState): string | null;
export function remoteUpdateInstallStageLabel(stage: string | null): string;
export function remoteUpdateFailureMessage(name: string, failure: RemoteUpdateFailure, targetVersion: string | null): string;
export function remoteUpdateSuccessTitle(name: string, version: string): string; // "{name} updated to v0.6.4"
```

- `ServerUpdateBadgeProps` gains `readonly run?: RemoteUpdateRunState | null` and `readonly onUpdate?: (() => void) | undefined` (the badge becomes the **Update to v{latest}…** button for an `interactive` host in `update-available`; used by the card).
- `apps/web/src/state/remoteUpdates.ts`: `export function useStartRemoteUpdate(): (environmentId: EnvironmentId, name: string) => void` — starts `remoteUpdateEnvironment.update` without an abort signal and shows one toast for the outcome (success, already up to date, or the failure sentence with **Retry**).

- [ ] **Step 1: Write the failing copy tests**

Create `apps/web/src/components/settings/remoteUpdatePresentation.test.ts`:

```ts
import { describe, expect, it } from "vite-plus/test";

import {
  remoteUpdateActionLabel,
  remoteUpdateConfirmation,
  remoteUpdateFailureMessage,
  remoteUpdateInstallStageLabel,
  remoteUpdateProgressLabel,
  remoteUpdateSuccessTitle,
} from "./remoteUpdatePresentation";

const base = {
  name: "Ai-server",
  targetVersion: "0.6.4",
  appVersion: "0.6.4",
  servesThisPage: false,
};
const KEPT =
  "Conversations and queued messages are kept, and agents continue when you send the next message.";

describe("remoteUpdateConfirmation", () => {
  it("names the counts that will stop", () => {
    const confirmation = remoteUpdateConfirmation({
      ...base,
      activeWork: { runningTurns: 2, liveTerminals: 3, queuedMessages: 1 },
    });
    expect(confirmation.lines).toEqual([
      "Updating Ai-server restarts BiBCode there.",
      `2 running agents and 3 terminals will stop. ${KEPT}`,
    ]);
    expect(confirmation.confirmLabel).toBe("Update Ai-server");
  });

  it("uses singular counts and drops a zero count", () => {
    expect(
      remoteUpdateConfirmation({
        ...base,
        activeWork: { runningTurns: 1, liveTerminals: 0, queuedMessages: 0 },
      }).lines[1],
    ).toBe(`1 running agent will stop. ${KEPT}`);
    expect(
      remoteUpdateConfirmation({
        ...base,
        activeWork: { runningTurns: 0, liveTerminals: 1, queuedMessages: 0 },
      }).lines[1],
    ).toBe(`1 terminal will stop. ${KEPT}`);
  });

  it("says nothing is running, or that running work will stop when it cannot count", () => {
    expect(
      remoteUpdateConfirmation({
        ...base,
        activeWork: { runningTurns: 0, liveTerminals: 0, queuedMessages: 4 },
      }).lines[1],
    ).toBe("Nothing is running on it now.");
    expect(remoteUpdateConfirmation({ ...base, activeWork: null }).lines[1]).toBe(
      `Running agents and terminals on it will stop. ${KEPT}`,
    );
  });

  it("warns when the server will be newer than this app, and when this page reloads", () => {
    const confirmation = remoteUpdateConfirmation({
      ...base,
      appVersion: "0.6.3",
      servesThisPage: true,
      activeWork: { runningTurns: 0, liveTerminals: 0, queuedMessages: 0 },
    });
    expect(confirmation.lines).toContain("This page reloads when Ai-server is back.");
    expect(confirmation.lines).toContain(
      "v0.6.4 is newer than this app (v0.6.3). Update this app too.",
    );
  });
});

describe("remote update progress and outcome", () => {
  it("labels every run phase with the spec copy", () => {
    expect(remoteUpdateActionLabel("0.6.4")).toBe("Update to v0.6.4…");
    expect(remoteUpdateProgressLabel({ phase: "queued" })).toBe("Queued");
    expect(
      remoteUpdateProgressLabel({ phase: "downloading", percent: 42, targetVersion: "0.6.4" }),
    ).toBe("Downloading 42%");
    expect(
      remoteUpdateProgressLabel({ phase: "downloading", percent: null, targetVersion: "0.6.4" }),
    ).toBe("Downloading…");
    expect(
      remoteUpdateProgressLabel({
        phase: "installing",
        stage: "creating-verified-backup",
        targetVersion: "0.6.4",
      }),
    ).toBe("Backing up project data…");
    expect(remoteUpdateProgressLabel({ phase: "restarting", targetVersion: "0.6.4" })).toBe(
      "Restarting…",
    );
    expect(remoteUpdateProgressLabel({ phase: "verifying", targetVersion: "0.6.4" })).toBe(
      "Checking the new version…",
    );
    expect(remoteUpdateProgressLabel({ phase: "succeeded", version: "0.6.4" })).toBe(
      "Updated to v0.6.4",
    );
    expect(remoteUpdateProgressLabel({ phase: "up-to-date" })).toBe("Already up to date");
  });

  it("maps protection stages to backup, stopping to restarting, and unknown stages to a generic label", () => {
    for (const stage of [
      "waiting-for-mutations",
      "quiescing-runtime",
      "acquiring-store-lock",
      "checkpointing-database",
      "creating-verified-backup",
    ]) {
      expect(remoteUpdateInstallStageLabel(stage)).toBe("Backing up project data…");
    }
    expect(remoteUpdateInstallStageLabel("stopping-backend")).toBe("Restarting…");
    expect(remoteUpdateInstallStageLabel("installing")).toBe("Restarting…");
    expect(remoteUpdateInstallStageLabel("defragmenting-disk")).toBe("Updating…");
    expect(remoteUpdateInstallStageLabel(null)).toBe("Updating…");
  });

  it("words each failure as the spec does", () => {
    expect(
      remoteUpdateFailureMessage(
        "Ai-server",
        { kind: "host-error", message: "Signature mismatch", runningVersion: "0.6.2" },
        "0.6.4",
      ),
    ).toBe("Couldn't update Ai-server: Signature mismatch. Nothing was installed; it runs v0.6.2 again.");
    expect(remoteUpdateFailureMessage("Ai-server", { kind: "not-back" }, "0.6.4")).toBe(
      "Ai-server hasn't come back after the update. Check BiBCode on Ai-server; it may be on a different port.",
    );
    expect(
      remoteUpdateFailureMessage(
        "Ai-server",
        { kind: "wrong-version", runningVersion: "0.6.2", targetVersion: "0.6.4" },
        "0.6.4",
      ),
    ).toBe("Ai-server restarted on v0.6.2 instead of v0.6.4.");
    expect(
      remoteUpdateFailureMessage(
        "Ai-server",
        { kind: "host-error", message: "the server did not answer before the update started.", runningVersion: "unknown" },
        null,
      ),
    ).toBe("Couldn't update Ai-server: the server did not answer before the update started. Nothing was installed.");
    expect(remoteUpdateSuccessTitle("Ai-server", "0.6.4")).toBe("Ai-server updated to v0.6.4");
  });
});
```

- [ ] **Step 2: Write the failing badge tests**

Append to `ServerUpdateBadge.test.tsx`:

```tsx
describe("ServerUpdateBadge while an update runs", () => {
  it("shows the run's progress instead of the snapshot", () => {
    const html = renderToStaticMarkup(
      <ServerUpdateBadge
        {...settled(interactiveSnapshot)}
        run={{ phase: "downloading", percent: 42, targetVersion: "0.5.0" }}
      />,
    );
    expect(html).toContain("Downloading 42%");
    expect(html).toContain('data-variant="busy"');
  });

  it("shows a failed run with its sentence as the reason", () => {
    const html = renderToStaticMarkup(
      <ServerUpdateBadge
        {...settled(interactiveSnapshot)}
        run={{ phase: "failed", failure: { kind: "not-back" } }}
      />,
    );
    expect(html).toContain('data-variant="error"');
    expect(html).toContain("hasn&#x27;t come back after the update");
  });

  it("becomes the update action for an interactive host with an update", () => {
    const onUpdate = vi.fn();
    const container = mount(<ServerUpdateBadge {...settled(interactiveSnapshot)} onUpdate={onUpdate} />);
    const button = container.querySelector("button");
    expect(button?.textContent).toBe("Update to v0.5.0…");
    act(() => button?.click());
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it("never offers the update action to a manual host", () => {
    const container = mount(<ServerUpdateBadge {...settled(manualSnapshot)} onUpdate={vi.fn()} />);
    expect(container.querySelector("button")).toBeNull();
  });
});
```

The failed-run test needs the name: give `ServerUpdateBadgeProps` a `readonly name?: string` used only in run failure reasons (default `"The server"`); pass `name="Ai-server"` in the test and assert `"Ai-server hasn"`.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `vp test run apps/web/src/components/settings/remoteUpdatePresentation.test.ts apps/web/src/components/settings/ServerUpdateBadge.test.tsx`
Expected: FAIL — module not found; `run`/`onUpdate` ignored.

- [ ] **Step 4: Implement the copy**

Create `apps/web/src/components/settings/remoteUpdatePresentation.ts`:

```ts
import type { RemoteUpdateActiveWork } from "@bibcode/contracts";
import type {
  RemoteUpdateFailure,
  RemoteUpdateRunState,
} from "@bibcode/client-runtime/state/remoteUpdateCoordinator";
import { compareSemverVersions } from "@bibcode/shared/semver";

const KEPT =
  "Conversations and queued messages are kept, and agents continue when you send the next message.";
const PROTECTION_STAGES = new Set([
  "waiting-for-mutations",
  "quiescing-runtime",
  "acquiring-store-lock",
  "checkpointing-database",
  "creating-verified-backup",
]);

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

export function remoteUpdateActionLabel(latestVersion: string): string {
  return `Update to v${latestVersion}…`;
}

function workLine(activeWork: RemoteUpdateActiveWork | null): string {
  if (activeWork === null) return `Running agents and terminals on it will stop. ${KEPT}`;
  const parts = [
    activeWork.runningTurns > 0 ? plural(activeWork.runningTurns, "running agent", "running agents") : null,
    activeWork.liveTerminals > 0 ? plural(activeWork.liveTerminals, "terminal", "terminals") : null,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return "Nothing is running on it now.";
  return `${parts.join(" and ")} will stop. ${KEPT}`;
}

export function remoteUpdateConfirmation(
  input: RemoteUpdateConfirmationInput,
): RemoteUpdateConfirmation {
  const lines = [`Updating ${input.name} restarts BiBCode there.`, workLine(input.activeWork)];
  if (input.servesThisPage) lines.push(`This page reloads when ${input.name} is back.`);
  if (
    input.targetVersion !== null &&
    compareSemverVersions(input.targetVersion, input.appVersion) > 0
  ) {
    lines.push(
      `v${input.targetVersion} is newer than this app (v${input.appVersion}). Update this app too.`,
    );
  }
  return {
    title: input.targetVersion === null ? `Update ${input.name}?` : `Update ${input.name} to v${input.targetVersion}?`,
    lines,
    confirmLabel: `Update ${input.name}`,
  };
}

export function remoteUpdateInstallStageLabel(stage: string | null): string {
  if (stage !== null && PROTECTION_STAGES.has(stage)) return "Backing up project data…";
  if (stage === "stopping-backend" || stage === "installing") return "Restarting…";
  return "Updating…";
}

export function remoteUpdateProgressLabel(state: RemoteUpdateRunState): string | null {
  switch (state.phase) {
    case "queued":
      return "Queued";
    case "starting":
      return "Updating…";
    case "downloading":
      return state.percent === null ? "Downloading…" : `Downloading ${Math.floor(state.percent)}%`;
    case "installing":
      return remoteUpdateInstallStageLabel(state.stage);
    case "restarting":
      return "Restarting…";
    case "verifying":
      return "Checking the new version…";
    case "succeeded":
      return `Updated to v${state.version}`;
    case "up-to-date":
      return "Already up to date";
    case "failed":
      return null; // the badge shows its error variant with the failure sentence
  }
}

const sentence = (text: string) => (/[.!?]$/u.test(text) ? text : `${text}.`);

export function remoteUpdateFailureMessage(
  name: string,
  failure: RemoteUpdateFailure,
  targetVersion: string | null,
): string {
  switch (failure.kind) {
    case "host-error":
      return failure.runningVersion === "unknown"
        ? `Couldn't update ${name}: ${sentence(failure.message)} Nothing was installed.`
        : `Couldn't update ${name}: ${sentence(failure.message)} Nothing was installed; it runs v${failure.runningVersion} again.`;
    case "not-back":
      return `${name} hasn't come back after the update. Check BiBCode on ${name}; it may be on a different port.`;
    case "wrong-version":
      return `${name} restarted on v${failure.runningVersion} instead of v${failure.targetVersion ?? targetVersion ?? "?"}.`;
    case "manual-required":
      return `Couldn't update ${name}: this server must be updated manually.`;
  }
}

export function remoteUpdateSuccessTitle(name: string, version: string): string {
  return `${name} updated to v${version}`;
}
```

(Export the two input/output interfaces from **Interfaces** in the same file. `sentence()` keeps "{host message}." from doubling a full stop the host already wrote.)

- [ ] **Step 5: Implement the badge and the start hook**

`ServerUpdateBadge.tsx`:
- Add the props `run`, `onUpdate`, `name` (Interfaces).
- Before computing `variant`, when `props.run` is non-null and either active or terminal-but-not-dismissed, derive `{ variant, label, reason }` from it: active phases and `up-to-date` → variant `"busy"` / `"up-to-date"` with `remoteUpdateProgressLabel(run)`; `succeeded` → variant `"up-to-date"` with `Updated to v…`; `failed` → variant `"error"` with label `"Update failed"` and reason `remoteUpdateFailureMessage(name ?? "The server", run.failure, null)`.
- When there is no run, `variant === "update-available"`, `snapshot.support.installMode === "interactive"`, `snapshot.latestVersion !== null` and `onUpdate` is set, render `<Button size="xs" variant="outline" onClick={onUpdate}>{remoteUpdateActionLabel(snapshot.latestVersion)}</Button>` instead of the passive span.
- Keep every existing variant and label unchanged when `run` is `null`.

`apps/web/src/state/remoteUpdates.ts`:

```ts
export function useStartRemoteUpdate(): (environmentId: EnvironmentId, name: string) => void {
  const registry = useContext(RegistryContext);
  return useCallback(
    (environmentId: EnvironmentId, name: string) => {
      void runAtomCommand(registry, remoteUpdateEnvironment.update, { environmentId, input: {} }, {
        label: remoteUpdateEnvironment.update.label,
        reportFailure: false,
      }).then((result) => {
        if (result._tag !== "Success") return;
        const outcome = result.value;
        if (outcome.phase === "succeeded") {
          toastManager.add({ type: "success", title: remoteUpdateSuccessTitle(name, outcome.version) });
        } else if (outcome.phase === "up-to-date") {
          toastManager.add({ type: "info", title: `${name} is already up to date` });
        } else if (outcome.phase === "failed") {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Update failed",
              description: remoteUpdateFailureMessage(name, outcome.failure, null),
              actionVariant: "outline",
              actionProps: { children: "Retry", onClick: () => startAgain(environmentId, name) },
            }),
          );
        }
      });
    },
    [registry],
  );
}
```

where `startAgain` is the same callback (define the inner function with `useCallback` and reference it through a `useRef`, or hoist a module-level `startRemoteUpdate(registry, environmentId, name)` function that both the hook and **Retry** call — prefer the module-level function; the hook only binds `registry`). `toastManager` and `stackedThreadToast` come from `apps/web/src/components/ui/toast.tsx` (as in `ConnectTab.tsx`); `"info"` is an accepted type. The toast fires even if the view that started the run has unmounted; that is intended (the run is not tied to a view).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `vp test run apps/web/src/components/settings/remoteUpdatePresentation.test.ts apps/web/src/components/settings/ServerUpdateBadge.test.tsx && vp run typecheck`
Expected: PASS and clean.

- [ ] **Step 7: Stop: the controller runs a Codex review and asks the user before committing.**

### Task 13: Settings row: confirmation, progress, failure and Retry

**Files:**
- Create: `apps/web/src/components/settings/UpdateServerDialog.tsx`, `apps/web/src/components/settings/UpdateServerDialog.test.tsx`
- Modify: `apps/web/src/components/settings/remote-servers/ConnectTab.tsx` (`RemoteServerRow`, `RemoteServerRowFromSession`), `ConnectTab.test.tsx`

**Interfaces:**
- Consumes: Task 12's presentation and `useStartRemoteUpdate`; `useRemoteUpdateRun` (Task 11); `remoteUpdateEnvironment.activeWork` (Task 11); `useEnvironmentQuery`.
- Produces:

```tsx
export interface UpdateServerRequest {
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly targetVersion: string | null;
  /** `capabilities.remoteUpdateProgress`: counts are available. */
  readonly progress: boolean;
  readonly servesThisPage: boolean;
}
export function UpdateServerDialog(props: {
  readonly request: UpdateServerRequest | null;
  readonly onClose: () => void;
  readonly onConfirm: (request: UpdateServerRequest) => void;
}): JSX.Element | null;
```

  The dialog reads `activeWork` only while open and only when `progress` is true; a pending read shows the counts line as "Counting running work…" with the confirm button enabled (the counts are advice; the user may confirm without them); a failed read falls back to the no-count line.
- `RemoteServerRowProps` loses `onInstallUpdate` and gains `run: RemoteUpdateRunState | null`, `onRequestUpdate: () => void`, `onRetryUpdate` keeps its meaning for the status read; the row's former **Update** button becomes **Update to v{latest}…**, hidden while a run is active, where the progress label shows instead; a failed run shows its sentence in the row with **Retry** (starts a new run) beside it.

- [ ] **Step 1: Write the failing dialog tests**

Create `apps/web/src/components/settings/UpdateServerDialog.test.tsx` (dialog and button mocks copied from `apps/web/src/components/desktop/UpdateProtectionDialog.test.tsx`):

```tsx
// @vitest-environment happy-dom

import { EnvironmentId } from "@bibcode/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const q = vi.hoisted(() => ({
  data: null as unknown,
  isPending: false,
  atoms: [] as unknown[],
}));

vi.mock("../ui/dialog", () => {
  const passthrough = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
      open ? <div>{children}</div> : null,
    DialogDescription: passthrough,
    DialogFooter: passthrough,
    DialogHeader: passthrough,
    DialogPanel: passthrough,
    DialogPopup: passthrough,
    DialogTitle: passthrough,
  };
});
vi.mock("../ui/button", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
}));
vi.mock("~/state/remoteUpdates", () => ({
  remoteUpdateEnvironment: {
    activeWork: (target: { environmentId: string }) => ({ __kind: "activeWork", ...target }),
  },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => {
    q.atoms.push(atom);
    return atom === null
      ? { data: null, isPending: false, error: null, refresh: vi.fn() }
      : { data: q.data, isPending: q.isPending, error: null, refresh: vi.fn() };
  },
}));

import { UpdateServerDialog, type UpdateServerRequest } from "./UpdateServerDialog";

const ENV = EnvironmentId.make("env-ai-server");
const request = (overrides: Partial<UpdateServerRequest> = {}): UpdateServerRequest => ({
  environmentId: ENV,
  name: "Ai-server",
  targetVersion: "0.6.4",
  progress: true,
  servesThisPage: false,
  ...overrides,
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  q.data = null;
  q.isPending = false;
  q.atoms = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const render = (element: React.ReactElement) => act(() => root.render(element));
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === label);

describe("UpdateServerDialog", () => {
  it("shows the counts and confirms with the named button", () => {
    q.data = { runningTurns: 2, liveTerminals: 3, queuedMessages: 0 };
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(<UpdateServerDialog request={request()} onClose={onClose} onConfirm={onConfirm} />);
    expect(container.textContent).toContain("Updating Ai-server restarts BiBCode there.");
    expect(container.textContent).toContain("2 running agents and 3 terminals will stop.");
    act(() => button("Update Ai-server")?.click());
    expect(onConfirm).toHaveBeenCalledWith(request());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("says it is counting while the read is pending, and still lets the user confirm", () => {
    q.isPending = true;
    render(<UpdateServerDialog request={request()} onClose={vi.fn()} onConfirm={vi.fn()} />);
    expect(container.textContent).toContain("Counting running work…");
    expect(button("Update Ai-server")?.disabled).toBe(false);
  });

  it("never reads counts from a server without the capability", () => {
    q.data = { runningTurns: 9, liveTerminals: 9, queuedMessages: 9 };
    render(
      <UpdateServerDialog request={request({ name: "Old-server", progress: false })} onClose={vi.fn()} onConfirm={vi.fn()} />,
    );
    expect(q.atoms.every((atom) => atom === null)).toBe(true);
    expect(container.textContent).toContain("Running agents and terminals on it will stop.");
  });

  it("cancels without starting an update", () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    render(<UpdateServerDialog request={request()} onClose={onClose} onConfirm={onConfirm} />);
    act(() => button("Cancel")?.click());
    expect(onClose).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Write the failing row tests**

In `ConnectTab.test.tsx` (its hoisted `h` harness already mocks `~/state/remoteUpdates` and `useEnvironmentQuery`):

1. Extend the harness object with `remoteUpdateRuns: new Map<string, unknown>()`, `startRemoteUpdate: vi.fn()`, and `updateDialog: { current: null as null | { request: unknown; onConfirm: (request: unknown) => void } }`; clear them in the existing `beforeEach`/reset block next to `h.remoteUpdateQueries.clear()`.
2. Extend the `~/state/remoteUpdates` mock with `activeWork: ({ environmentId }: { environmentId: string }) => ({ __kind: "remoteUpdateActiveWork", environmentId })`, `useRemoteUpdateRun: (environmentId: string | null) => (environmentId === null ? null : (h.remoteUpdateRuns.get(environmentId) ?? null))` and `useStartRemoteUpdate: () => h.startRemoteUpdate`.
3. Mock the dialog so the row test does not depend on portals: `vi.mock("../UpdateServerDialog", () => ({ UpdateServerDialog: (props: { request: unknown; onConfirm: (request: unknown) => void }) => { h.updateDialog.current = props.request === null ? null : props; return null; } }))`.

Then add to `describe("Check for Server Updates placement", …)`:

```tsx
    it("offers Update to v… and asks before updating", async () => {
      stubBrowserWindow();
      h.hasCloudConfig = false;
      const environmentId = EnvironmentId.make("env-update");
      h.environments = [
        environment({
          id: environmentId,
          label: "Ai-server",
          connection: { phase: "connected" },
          serverConfig: updateCapableConfig(),
        }),
      ];
      h.remoteUpdateQueries.set(
        environmentId,
        settledUpdateQuery({ ...UP_TO_DATE_SNAPSHOT, latestVersion: "0.6.4", state: "update-available" }),
      );

      await mountConnections(<ConnectTab />);
      await act(async () => {
        clickButton("Update to v0.6.4…");
        await flush();
      });

      expect(h.updateDialog.current?.request).toMatchObject({
        environmentId,
        name: "Ai-server",
        targetVersion: "0.6.4",
      });
      expect(h.startRemoteUpdate).not.toHaveBeenCalled();
      expect(h.commands.remoteUpdateInstall).not.toHaveBeenCalled();
      await act(async () => {
        h.updateDialog.current?.onConfirm(h.updateDialog.current.request);
        await flush();
      });
      expect(h.startRemoteUpdate).toHaveBeenCalledExactlyOnceWith(environmentId, "Ai-server");
    });

    it("replaces the action with the run's progress and stops reading the status", async () => {
      stubBrowserWindow();
      h.hasCloudConfig = false;
      const environmentId = EnvironmentId.make("env-installing");
      h.environments = [
        environment({
          id: environmentId,
          label: "Ai-server",
          connection: { phase: "connected" },
          serverConfig: updateCapableConfig(),
        }),
      ];
      h.remoteUpdateQueries.set(
        environmentId,
        settledUpdateQuery({ ...UP_TO_DATE_SNAPSHOT, latestVersion: "0.6.4", state: "update-available" }),
      );
      h.remoteUpdateRuns.set(environmentId, {
        phase: "installing",
        stage: "creating-verified-backup",
        targetVersion: "0.6.4",
      });

      const container = await mountConnections(<ConnectTab />);

      expect(container.textContent).toContain("Backing up project data…");
      expect(findControls("button", "Update to v0.6.4…")).toHaveLength(0);
      expect(control("button", "Check").props.disabled).toBe(true);
    });

    it("shows a failed run's sentence with Retry, which starts a new run", async () => {
      stubBrowserWindow();
      h.hasCloudConfig = false;
      const environmentId = EnvironmentId.make("env-failed");
      h.environments = [
        environment({
          id: environmentId,
          label: "Ai-server",
          connection: { phase: "connected" },
          serverConfig: updateCapableConfig(),
        }),
      ];
      h.remoteUpdateQueries.set(environmentId, settledUpdateQuery(UP_TO_DATE_SNAPSHOT));
      h.remoteUpdateRuns.set(environmentId, {
        phase: "failed",
        failure: { kind: "wrong-version", runningVersion: "0.6.2", targetVersion: "0.6.4" },
      });

      const container = await mountConnections(<ConnectTab />);

      expect(container.textContent).toContain("Ai-server restarted on v0.6.2 instead of v0.6.4.");
      await act(async () => {
        clickButton("Retry");
        await flush();
      });
      expect(h.startRemoteUpdate).toHaveBeenCalledExactlyOnceWith(environmentId, "Ai-server");
    });
```

The progress test's "stops reading the status" half: the `useEnvironmentQuery` mock receives `null` while the run is active; assert it by recording the atoms passed to the mock (`h.queriedAtoms.push(atom)`) and checking that no `remoteUpdateSnapshot` atom for `environmentId` was queried during this render. The old tests that asserted the **Update** button and `remoteUpdateInstall` (search `remoteUpdateInstall` in this file) now assert **Update to v…** and the dialog flow; update them rather than deleting their coverage.

**Retry** after a failure starts a new run directly (the user already confirmed this update; the failure toast's **Retry** does the same). Record this in the report as a UI decision for the UI.md review.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `vp test run apps/web/src/components/settings/UpdateServerDialog.test.tsx apps/web/src/components/settings/remote-servers/ConnectTab.test.tsx`
Expected: FAIL.

- [ ] **Step 4: Implement the dialog**

`UpdateServerDialog.tsx` follows `RenameServerDialog.tsx` (same `Dialog`, `DialogPopup`, `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogPanel`, `DialogFooter`, `Button` imports; body keyed by `environmentId`):

```tsx
export function UpdateServerDialog({ request, onClose, onConfirm }: UpdateServerDialogProps) {
  return request === null ? null : (
    <UpdateServerDialogBody key={request.environmentId} request={request} onClose={onClose} onConfirm={onConfirm} />
  );
}

function UpdateServerDialogBody({ request, onClose, onConfirm }: …) {
  const work = useEnvironmentQuery(
    request.progress
      ? remoteUpdateEnvironment.activeWork({ environmentId: request.environmentId, input: {} })
      : null,
  );
  const counting = request.progress && work.isPending && work.data === null;
  const confirmation = remoteUpdateConfirmation({
    name: request.name,
    targetVersion: request.targetVersion,
    activeWork: request.progress ? work.data : null,
    appVersion: APP_VERSION,
    servesThisPage: request.servesThisPage,
  });
  const [first, second, ...rest] = confirmation.lines;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{confirmation.title}</DialogTitle>
          <DialogDescription>{first}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-2 text-sm">
          <p>{counting ? "Counting running work…" : second}</p>
          {rest.map((line) => <p key={line}>{line}</p>)}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="button" onClick={() => { onConfirm(request); onClose(); }}>
            {confirmation.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
```

(`work.data` is `RemoteUpdateActiveWork | null`; a failed read leaves it `null`, which yields the no-count line. Use the real `useEnvironmentQuery` import path used by `ConnectTab.tsx`.)

- [ ] **Step 5: Implement the row**

In `RemoteServerRowFromSession`:
- `const run = useRemoteUpdateRun(remoteUpdateControl ? environmentId : null);`
- `const runActive = isRemoteUpdateRunActive(run);`
- Pass `null` to `useEnvironmentQuery` while `runActive` (spec: the status query is not observed alongside a run): `remoteUpdateControl && !runActive ? remoteUpdateEnvironment.snapshot(…) : null`. Keep liveness's revalidation calls as they are when it has landed.
- Replace `installUpdate`/`runInstall`/`installPending`/`manualInstallRequired` with the dialog flow: `const [updateRequest, setUpdateRequest] = useState<UpdateServerRequest | null>(null); const startUpdate = useStartRemoteUpdate();` and `onRequestUpdate={() => setUpdateRequest({ environmentId, name: props.environment.label, targetVersion: updateStatus.snapshot?.latestVersion ?? null, progress: props.environment.serverConfig?.environment.capabilities.remoteUpdateProgress ?? false, servesThisPage: false })}`; render `<UpdateServerDialog request={updateRequest} onClose={() => setUpdateRequest(null)} onConfirm={(request) => startUpdate(request.environmentId, request.name)} />` next to the row. A `manual-required` outcome now arrives as a failed run (`failure.kind === "manual-required"`); show it through the failure sentence and the manual steps (Task 15) instead of the old `manualInstallRequired` override.
- Rows for saved remote servers never serve the browser page; `servesThisPage` is `false` here (see open question 1).

In `RemoteServerRow`:
- `run` is passed to `<ServerUpdateBadge {...updateStatus} run={run} name={environment.label} onRetry={onRetryUpdate} />`.
- The action area: while `isRemoteUpdateRunActive(run)`, render the progress label as muted text (`<span className="text-xs text-muted-foreground" aria-live="polite">{remoteUpdateProgressLabel(run)}</span>`) and disable **Check**; else if `run?.phase === "failed"` render the failure sentence under the badges (`<p className="text-xs text-destructive">…</p>`) and a **Retry** button (`onClick={onRetryRun}`, which calls `startUpdate(environmentId, label)`); else keep **Check** and, for an interactive `update-available` snapshot, the button labelled `remoteUpdateActionLabel(snapshot.latestVersion)` calling `onRequestUpdate`.
- Remove `installInFlight` (the run owns that state).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `vp test run apps/web/src/components/settings/UpdateServerDialog.test.tsx apps/web/src/components/settings/remote-servers/ConnectTab.test.tsx apps/web/src/components/settings/ServerUpdateBadge.test.tsx && vp run typecheck`
Expected: PASS and clean.

- [ ] **Step 7: Stop: the controller runs a Codex review and asks the user before committing.**

### Task 14: The sidebar card: update action, progress and failure

**Files (track B coordination applies; see open question 7):**
- Modify: `apps/web/src/components/Sidebar.tsx` (`SidebarEnvironmentContextCard` only)
- Modify: `apps/web/src/components/sidebar/EnvironmentContextCard.tsx`, `apps/web/src/components/sidebar/EnvironmentContextCard.test.tsx`
- Modify: `apps/web/src/components/sidebar/environmentContextCard.logic.ts` only if the view model needs the install mode (Task 15 does)

**Interfaces:**
- Consumes: `ServerUpdateBadge` `run`/`onUpdate`/`name` (Task 12), `UpdateServerDialog` (Task 13), `useRemoteUpdateRun`, `useStartRemoteUpdate`.
- Produces: `EnvironmentContextCardProps` gains `readonly updateDialog?: React.ReactNode` (rendered after the card so the dialog mounts while the card is visible). Everything else flows through the existing `updateBadge` slot.

- [ ] **Step 1: Write the failing test**

In `EnvironmentContextCard.test.tsx` (static render, its hoisted `h` harness and `remoteEnvironment()` helper):

```tsx
  it("renders the update dialog slot beside the card", () => {
    h.reset();
    h.activeEnvironmentId = ENV_REMOTE;
    h.environment = remoteEnvironment({
      environment: { serverVersion: "0.6.2", capabilities: {} },
    });
    const markup = renderToStaticMarkup(
      <EnvironmentContextCard
        updateBadge={<span data-testid="update-badge">Update to v0.6.4…</span>}
        updateDialog={<div data-testid="update-dialog" />}
      />,
    );
    expect(markup).toContain('data-testid="update-badge"');
    expect(markup).toContain('data-testid="update-dialog"');
  });
```

The card only hosts slots; the badge's action and progress are covered by Task 12's `ServerUpdateBadge` tests. The wiring goes in `apps/web/src/components/Sidebar.test.tsx`, which captures the card's props (`vi.mock("./sidebar/EnvironmentContextCard", …)` with `h.mk`) and mocks `../state/query`:

1. Add `remoteUpdateRuns: new Map<string, unknown>()`, `startRemoteUpdate: vi.fn()` and `snapshotQueries: [] as string[]` to its hoisted state (reset them where the file resets `h.state`).
2. Add a partial mock that keeps the real module and overrides the two hooks:

```tsx
vi.mock("../state/remoteUpdates", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/remoteUpdates")>()),
  useRemoteUpdateRun: (environmentId: string | null) =>
    environmentId === null ? null : (h.state.remoteUpdateRuns.get(environmentId) ?? null),
  useStartRemoteUpdate: () => h.state.startRemoteUpdate,
}));
```

3. In the existing `../state/query` mock, record the environment id of every atom whose label starts with `environment-data:remote-update:snapshot` into `h.state.snapshotQueries` (inspect the atom shape the mock receives today and match on the field it carries).
4. Add next to `mounts the environment context card under the brand row`:

```tsx
  it("passes the running update to the card badge and stops reading the status", () => {
    seedTwoEnvironments();
    h.state.environments[1] = environmentFixture({
      environmentId: ENV_REMOTE,
      label: "AI-SERVER",
      connectionId: "paired-1",
      serverConfig: {
        environment: { serverVersion: "0.6.2", capabilities: { remoteUpdateControl: true } },
      },
    });
    h.state.activeEnvironmentId = ENV_REMOTE;
    h.state.remoteUpdateRuns.set(ENV_REMOTE, { phase: "restarting", targetVersion: "0.6.4" });

    render(<Sidebar />);

    const card = captured("EnvironmentContextCard")[0]!;
    const badge = card.props["updateBadge"] as React.ReactElement<{ run: unknown; name: string }>;
    expect(badge.props.run).toEqual({ phase: "restarting", targetVersion: "0.6.4" });
    expect(badge.props.name).toBe("AI-SERVER");
    expect(card.props["updateDialog"]).toBeDefined();
    expect(h.state.snapshotQueries).not.toContain(ENV_REMOTE);
  });
```

If `environmentFixture` does not accept `serverConfig`, extend it with an optional `serverConfig` that defaults to today's value.

- [ ] **Step 2: Run the test to verify it fails**

Run: `vp test run apps/web/src/components/sidebar/EnvironmentContextCard.test.tsx apps/web/src/components/Sidebar.test.tsx`
Expected: FAIL — `updateDialog` is not a known prop and is not rendered; the Sidebar case fails because the card still reads the status and shows no progress.

- [ ] **Step 3: Implement in `SidebarEnvironmentContextCard`**

```tsx
  const run = useRemoteUpdateRun(updateEnvironmentId);
  const runActive = isRemoteUpdateRunActive(run);
  const updateQuery = useEnvironmentQuery(
    updateEnvironmentId === null || runActive
      ? null
      : remoteUpdateEnvironment.snapshot({ environmentId: updateEnvironmentId, input: {} }),
  );
  const startUpdate = useStartRemoteUpdate();
  const [updateRequest, setUpdateRequest] = useState<UpdateServerRequest | null>(null);
  const label = environment?.label ?? "";
  const requestUpdate = useCallback(() => {
    if (updateEnvironmentId === null) return;
    setUpdateRequest({
      environmentId: updateEnvironmentId,
      name: label,
      targetVersion: updateQuery.data?.latestVersion ?? null,
      progress: environment?.serverConfig?.environment.capabilities.remoteUpdateProgress ?? false,
      servesThisPage: false,
    });
  }, [environment?.serverConfig, label, updateEnvironmentId, updateQuery.data?.latestVersion]);
```

Pass `run={run}`, `name={label}`, `onUpdate={requestUpdate}` to the card's `ServerUpdateBadge`, and `updateDialog={<UpdateServerDialog request={updateRequest} onClose={() => setUpdateRequest(null)} onConfirm={(request) => startUpdate(request.environmentId, request.name)} />}`. A failed run's **Retry** in the card is the toast's **Retry** (Task 12) plus the badge tooltip; the card has no room for a second line. In `EnvironmentContextCard.tsx` render `{props.updateDialog ?? null}` as a sibling after the card `div` (wrap both in a fragment).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `vp test run apps/web/src/components/sidebar/EnvironmentContextCard.test.tsx apps/web/src/components/Sidebar.test.tsx && vp run typecheck`
Expected: PASS and clean.

- [ ] **Step 5: Stop: the controller runs a Codex review and asks the user before committing.**

### Task 15: **Show update steps** for manual hosts

**Files:**
- Create: `apps/web/src/components/settings/ManualUpdateStepsDialog.tsx`
- Modify: `apps/web/src/components/settings/remoteUpdatePresentation.ts` (+ test) — add `manualUpdateSteps`
- Modify: `apps/web/src/components/settings/ServerUpdateBadge.tsx` (+ test) — remove `manualUpdateInstructions` (moved and replaced)
- Modify: `apps/web/src/components/settings/remote-servers/ConnectTab.tsx` (+ test) — the manual steps block
- Modify: `apps/web/src/components/sidebar/EnvironmentContextCard.tsx`, `apps/web/src/components/sidebar/environmentContextCard.logic.ts` (+ tests), `apps/web/src/components/Sidebar.tsx` (`SidebarEnvironmentContextCard` only)

**Interfaces:**
- Produces:

```ts
export interface ManualUpdateStepsInput {
  readonly installKind: string;            // snapshot.support.installKind
  readonly os: "darwin" | "linux" | "windows" | "unknown";
  readonly arch: "arm64" | "x64" | "other";
  readonly sshLaunched: boolean;           // target._tag === "SshConnectionTarget"
  readonly serverVersion: string;
}
export function manualUpdateSteps(input: ManualUpdateStepsInput): string;
```

  - `EnvironmentContextCardView` gains `readonly manualUpdates: boolean` (`remoteUpdateSupport.installMode === "manual"` from the descriptor); the card menu shows **Show update steps** instead of **Check for updates** when it is true, via a new prop `onShowUpdateSteps?: (environmentId: EnvironmentId) => void`.
  - `ManualUpdateStepsDialog({ request, onClose })` with `request: { name: string; steps: string } | null`, a `<pre>` block and a **Copy** button (`useCopyToClipboard`, same toasts as today's "Update instructions copied").

- [ ] **Step 1: Write the failing tests**

In `remoteUpdatePresentation.test.ts`:

```ts
describe("manualUpdateSteps", () => {
  const base = { serverVersion: "0.6.2", sshLaunched: false } as const;

  it("gives archive steps with the host's asset and checksum check", () => {
    const steps = manualUpdateSteps({ ...base, installKind: "archive", os: "linux", arch: "arm64" });
    expect(steps).toContain("bibcode-server-vVERSION-linux-aarch64.tar.gz");
    expect(steps).toContain("bibcode-server-SHA256SUMS");
    expect(steps).toContain("sha256sum --check -");
    expect(steps).toContain("# Currently running: v0.6.2");
  });

  it("uses shasum on macOS and a zip on Windows", () => {
    expect(manualUpdateSteps({ ...base, installKind: "archive", os: "darwin", arch: "x64" })).toContain(
      "shasum -a 256 -c",
    );
    expect(manualUpdateSteps({ ...base, installKind: "archive", os: "windows", arch: "x64" })).toContain(
      "bibcode-server-vVERSION-windows-x86_64.zip",
    );
  });

  it("gives both package commands for a system package", () => {
    const steps = manualUpdateSteps({ ...base, installKind: "system-package", os: "linux", arch: "x64" });
    expect(steps).toContain("sudo apt install ./bibcode-server_VERSION_amd64.deb");
    expect(steps).toContain("sudo dnf install ./bibcode-server-VERSION-1.x86_64.rpm");
  });

  it("tells an SSH-launched server to stop so the next connection relaunches it", () => {
    const steps = manualUpdateSteps({ ...base, installKind: "unknown", os: "linux", arch: "x64", sshLaunched: true });
    expect(steps).toContain("~/.bibcode-ssh-launch");
    expect(steps).toContain("Reconnect");
  });

  it("falls back to generic steps for an unknown kind", () => {
    const steps = manualUpdateSteps({ ...base, installKind: "flatpak", os: "linux", arch: "x64" });
    expect(steps).toContain("bibcode serve");
    expect(steps).not.toContain("SHA256SUMS");
  });
});
```

In `environmentContextCard.logic.test.ts`, add: a manual descriptor (`remoteUpdateSupport.installMode: "manual"`) yields `manualUpdates: true`; an interactive one `false`. In `EnvironmentContextCard.test.tsx`, add: with `manualUpdates` the menu lists **Show update steps** and not **Check for updates**.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `vp test run apps/web/src/components/settings/remoteUpdatePresentation.test.ts apps/web/src/components/sidebar/environmentContextCard.logic.test.ts apps/web/src/components/sidebar/EnvironmentContextCard.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement `manualUpdateSteps`**

```ts
const ARCHIVE_ARCH = { arm64: "aarch64", x64: "x86_64", other: "ARCH" } as const;
const DEB_ARCH = { arm64: "arm64", x64: "amd64", other: "ARCH" } as const;
const RPM_ARCH = { arm64: "aarch64", x64: "x86_64", other: "ARCH" } as const;

export function manualUpdateSteps(input: ManualUpdateStepsInput): string {
  const running = `# Currently running: v${input.serverVersion}`;
  if (input.sshLaunched) {
    // Paths follow REMOTE_LAUNCH_SCRIPT in apps/desktop/src-tauri/src/ssh.rs; re-check them there.
    return [
      "# This server was started by BiBCode over SSH.",
      "# 1. Install the new bibcode on the host so `bibcode --version` shows it.",
      "# 2. Stop the running server:",
      'kill "$(cat ~/.bibcode-ssh-launch/*/pid)"',
      "# 3. Reconnect from BiBCode; it starts the new server.",
      "",
      running,
    ].join("\n");
  }
  const os = input.os === "darwin" ? "darwin" : input.os === "windows" ? "windows" : "linux";
  switch (input.installKind) {
    case "archive": {
      const asset = `bibcode-server-vVERSION-${os}-${ARCHIVE_ARCH[input.arch]}.${os === "windows" ? "zip" : "tar.gz"}`;
      const check = os === "darwin" ? "shasum -a 256 -c" : "sha256sum --check -";
      return [
        "# Replace VERSION with the release to install, from the BiBCode releases page.",
        `# 1. Download ${asset} and bibcode-server-SHA256SUMS.`,
        "# 2. Check the download:",
        `grep "  ${asset}$" bibcode-server-SHA256SUMS | ${check}`,
        "# 3. Stop the running server, replace the extracted folder, and start it again:",
        "bibcode serve",
        "",
        running,
      ].join("\n");
    }
    case "system-package":
      return [
        "# Replace VERSION with the release to install, from the BiBCode releases page.",
        "# 1. Download the package for this host and check it against bibcode-server-SHA256SUMS.",
        "# 2. Install it (Debian or Ubuntu, or Fedora):",
        `sudo apt install ./bibcode-server_VERSION_${DEB_ARCH[input.arch]}.deb`,
        `sudo dnf install ./bibcode-server-VERSION-1.${RPM_ARCH[input.arch]}.rpm`,
        "# 3. Restart the running server (or its service).",
        "",
        running,
      ].join("\n");
    default:
      return [
        "# Update this BiBCode server manually on its host:",
        "# 1. Stop the running server (Ctrl+C or your service manager).",
        "# 2. Install the latest bibcode build (replace the binary on PATH).",
        "# 3. Restart it:",
        "bibcode serve",
        "",
        running,
      ].join("\n");
  }
}
```

Asset and package names match `docs/user/server-installation.md` and the release scripts (`bibcode-server-v${version}-${os}-${arch}`, `bibcode-server_${version}_${debArch}.deb`, `bibcode-server-${version}-1.${rpmArch}.rpm`).

- [ ] **Step 4: Wire the row and the card**

- Remove `manualUpdateInstructions` from `ServerUpdateBadge.tsx` and its test; update imports.
- `ConnectTab.tsx::RemoteServerRow`: build `updateInstructions` with `manualUpdateSteps({ installKind: updateSnapshot.support.installKind, os: environment.serverConfig?.environment.platform.os ?? "unknown", arch: environment.serverConfig?.environment.platform.arch ?? "other", sshLaunched: environment.entry.target._tag === "SshConnectionTarget", serverVersion: updateSnapshot.serverVersion })`; rename the collapsible trigger to **Show update steps** and the copy button to **Copy**.
- `environmentContextCard.logic.ts`: `manualUpdates: input.serverConfig?.environment.remoteUpdateSupport?.installMode === "manual"`.
- `EnvironmentContextCard.tsx`: when `view.manualUpdates && props.onShowUpdateSteps`, the menu item reads **Show update steps** and calls it; otherwise keep **Check for updates**.
- `SidebarEnvironmentContextCard`: hold `const [stepsRequest, setStepsRequest] = useState<{ name: string; steps: string } | null>(null)`, pass `onShowUpdateSteps` building the steps from `updateQuery.data` (or the descriptor's `serverVersion` when the status has not loaded) and render `<ManualUpdateStepsDialog request={stepsRequest} onClose={() => setStepsRequest(null)} />` through `updateDialog` (wrap both dialogs in a fragment).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `vp test run apps/web/src/components/settings apps/web/src/components/sidebar/EnvironmentContextCard.test.tsx apps/web/src/components/sidebar/environmentContextCard.logic.test.ts && vp run typecheck`
Expected: PASS and clean.

- [ ] **Step 6: Stop: the controller runs a Codex review and asks the user before committing.**

### Task 16: App-level notices: the host toast and the browser reload prompt

**Files:**
- Create: `apps/web/src/components/RemoteUpdateRequestNotifier.tsx`, `apps/web/src/components/RemoteUpdateRequestNotifier.test.tsx`
- Create: `apps/web/src/serverReload.logic.ts`, `apps/web/src/serverReload.logic.test.ts`
- Create: `apps/web/src/components/ServerReloadPrompt.tsx`
- Modify: `apps/web/src/AppRoot.tsx`

**Interfaces:**
- Consumes: `useDesktopUpdateState()` (`apps/web/src/state/desktopUpdate.ts`), `DesktopUpdateState.requestedBy` (Task 8), `usePrimaryEnvironment()` (`apps/web/src/state/environments.ts`), `ExecutionEnvironmentDescriptor.bootId` (Task 5), `APP_VERSION`, `isDesktopHost` (`apps/web/src/env.ts`).
- Produces:

```ts
// RemoteUpdateRequestNotifier.tsx
export function remoteUpdateRequestToast(
  requestedBy: { label: string; detail: string | null },
  version: string | null,
): { title: string; description: string };
export function RemoteUpdateRequestNotifier(props: { readonly onManageDevices: () => void }): null;

// serverReload.logic.ts
export interface ServerBoot { readonly bootId: string | null; readonly serverVersion: string }
/** The version to offer a reload for, or null. `firstBoot` is the boot the page first saw. */
export function serverReloadVersion(input: {
  readonly desktop: boolean;
  readonly bundleVersion: string;
  readonly firstBoot: ServerBoot | null;
  readonly current: ServerBoot | null;
}): string | null;
```

- [ ] **Step 1: Write the failing tests**

`apps/web/src/serverReload.logic.test.ts`:

```ts
import { describe, expect, it } from "vite-plus/test";
import { serverReloadVersion } from "./serverReload.logic";

const first = { bootId: "boot-1", serverVersion: "0.6.2" };

describe("serverReloadVersion", () => {
  it("offers a reload when the page's server came back on a new boot and another version", () => {
    expect(
      serverReloadVersion({ desktop: false, bundleVersion: "0.6.2", firstBoot: first, current: { bootId: "boot-2", serverVersion: "0.6.4" } }),
    ).toBe("0.6.4");
  });

  it("stays quiet for a reconnect to the same boot, the bundle's own version, or the desktop app", () => {
    expect(serverReloadVersion({ desktop: false, bundleVersion: "0.6.2", firstBoot: first, current: first })).toBeNull();
    expect(
      serverReloadVersion({ desktop: false, bundleVersion: "0.6.4", firstBoot: first, current: { bootId: "boot-2", serverVersion: "0.6.4" } }),
    ).toBeNull();
    expect(
      serverReloadVersion({ desktop: true, bundleVersion: "0.6.2", firstBoot: first, current: { bootId: "boot-2", serverVersion: "0.6.4" } }),
    ).toBeNull();
  });

  it("stays quiet for a server without bootId", () => {
    expect(
      serverReloadVersion({
        desktop: false,
        bundleVersion: "0.6.2",
        firstBoot: { bootId: null, serverVersion: "0.6.2" },
        current: { bootId: null, serverVersion: "0.6.4" },
      }),
    ).toBeNull();
  });
});
```

`apps/web/src/components/RemoteUpdateRequestNotifier.test.tsx`:

```tsx
// @vitest-environment happy-dom

import type { DesktopUpdateState } from "@bibcode/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const t = vi.hoisted(() => ({
  state: null as DesktopUpdateState | null,
  toasts: [] as Array<Record<string, unknown>>,
}));

vi.mock("../state/desktopUpdate", () => ({ useDesktopUpdateState: () => t.state }));
vi.mock("./ui/toast", () => ({
  toastManager: { add: (toast: Record<string, unknown>) => t.toasts.push(toast) },
  stackedThreadToast: (toast: Record<string, unknown>) => toast,
}));

import { RemoteUpdateRequestNotifier, remoteUpdateRequestToast } from "./RemoteUpdateRequestNotifier";

const baseState: DesktopUpdateState = {
  enabled: true,
  status: "downloaded",
  currentVersion: "0.6.2",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: "0.6.4",
  downloadedVersion: "0.6.4",
  downloadPercent: 100,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
  phase: "available",
  protection: [],
  requestedBy: null,
};

let container: HTMLDivElement;
let root: Root;
const onManageDevices = vi.fn();
const show = (state: DesktopUpdateState | null) => {
  t.state = state;
  act(() => root.render(<RemoteUpdateRequestNotifier onManageDevices={onManageDevices} />));
};

beforeEach(() => {
  t.state = null;
  t.toasts = [];
  onManageDevices.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("remoteUpdateRequestToast", () => {
  it("names the device, its OS and address, and the version", () => {
    expect(
      remoteUpdateRequestToast({ label: "BiBCode Desktop", detail: "MacIntel (192.168.1.34)" }, "0.6.4"),
    ).toEqual({
      title: "Update requested from another device",
      description:
        "BiBCode Desktop on MacIntel (192.168.1.34) is installing v0.6.4. BiBCode restarts when it's done.",
    });
    expect(remoteUpdateRequestToast({ label: "Another device", detail: null }, null).description).toBe(
      "Another device is installing an update. BiBCode restarts when it's done.",
    );
  });
});

describe("RemoteUpdateRequestNotifier", () => {
  it("toasts once per install and again only for the next request", () => {
    show(baseState);
    show({ ...baseState, requestedBy: { label: "Tablet", detail: null } });
    show({ ...baseState, phase: "protecting", requestedBy: { label: "Tablet", detail: null } });
    expect(t.toasts).toHaveLength(1);
    expect(t.toasts[0]).toMatchObject({
      title: "Update requested from another device",
      description: "Tablet is installing v0.6.4. BiBCode restarts when it's done.",
    });

    show({ ...baseState, requestedBy: null });
    show({ ...baseState, requestedBy: { label: "Laptop", detail: null } });
    expect(t.toasts).toHaveLength(2);
  });

  it("offers Manage devices", () => {
    show({ ...baseState, requestedBy: { label: "Tablet", detail: null } });
    const action = t.toasts[0]?.actionProps as { children: string; onClick: () => void };
    expect(action.children).toBe("Manage devices");
    action.onClick();
    expect(onManageDevices).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `vp test run apps/web/src/serverReload.logic.test.ts apps/web/src/components/RemoteUpdateRequestNotifier.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`serverReload.logic.ts`:

```ts
export function serverReloadVersion(input: {…}): string | null {
  const { desktop, bundleVersion, firstBoot, current } = input;
  if (desktop || firstBoot === null || current === null) return null;
  if (firstBoot.bootId === null || current.bootId === null) return null;
  if (current.bootId === firstBoot.bootId) return null;
  return current.serverVersion === bundleVersion ? null : current.serverVersion;
}
```

`ServerReloadPrompt.tsx` (browser only; returns `null` in the desktop app):

```tsx
export function ServerReloadPrompt() {
  const primary = usePrimaryEnvironment();
  const descriptor = primary?.serverConfig?.environment ?? null;
  const firstBoot = useRef<ServerBoot | null>(null);
  if (firstBoot.current === null && descriptor !== null) {
    firstBoot.current = { bootId: descriptor.bootId, serverVersion: descriptor.serverVersion };
  }
  const version = serverReloadVersion({
    desktop: isDesktopHost,
    bundleVersion: APP_VERSION,
    firstBoot: firstBoot.current,
    current: descriptor === null ? null : { bootId: descriptor.bootId, serverVersion: descriptor.serverVersion },
  });
  if (version === null) return null;
  return (
    <div role="status" className="fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-3 border-b border-border bg-background px-4 py-2 text-sm">
      <span>BiBCode on this server was updated to v{version}. Reload to use it.</span>
      <Button size="xs" onClick={() => window.location.reload()}>Reload</Button>
    </div>
  );
}
```

(Writing a ref during render is acceptable here only because it records the first value once and is idempotent; if the React review objects, move it to a `useEffect` that sets state once. It never reloads by itself, so unsent composer text survives until the user chooses.)

`RemoteUpdateRequestNotifier.tsx`:

```tsx
export function remoteUpdateRequestToast(requestedBy: { label: string; detail: string | null }, version: string | null) {
  const who = requestedBy.detail === null ? requestedBy.label : `${requestedBy.label} on ${requestedBy.detail}`;
  const what = version === null ? "an update" : `v${version}`;
  return {
    title: "Update requested from another device",
    description: `${who} is installing ${what}. BiBCode restarts when it's done.`,
  };
}

export function RemoteUpdateRequestNotifier({ onManageDevices }: { readonly onManageDevices: () => void }) {
  const state = useDesktopUpdateState();
  const requestedBy = state?.requestedBy ?? null;
  const announced = useRef(false);
  useEffect(() => {
    if (requestedBy === null) {
      announced.current = false;
      return;
    }
    if (announced.current) return;
    announced.current = true;
    const toast = remoteUpdateRequestToast(requestedBy, state?.downloadedVersion ?? state?.availableVersion ?? null);
    toastManager.add(
      stackedThreadToast({
        type: "info",
        ...toast,
        actionVariant: "outline",
        actionProps: { children: "Manage devices", onClick: onManageDevices },
      }),
    );
  }, [onManageDevices, requestedBy, state?.availableVersion, state?.downloadedVersion]);
  return null;
}
```

The version may be `null` at the first emission (the flow checks the feed first); the toast then says "an update". Do not re-toast when the version arrives.

`AppRoot.tsx`, inside `AppAtomRegistryProvider` after `<ProjectDataRecoveryCoordinator />`:

```tsx
      {isDesktopHost ? (
        <RemoteUpdateRequestNotifier
          onManageDevices={() =>
            void router.navigate({ to: "/settings/remote-servers", search: { tab: "share" } })
          }
        />
      ) : (
        <ServerReloadPrompt />
      )}
```

(`validateRemoteServersSearch` already accepts `tab: "share"`; `RemoteServersSettings` opens **Share this host**, where the device can be revoked. Wrap `onManageDevices` in `useCallback` if the React review asks for a stable prop.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `vp test run apps/web/src/serverReload.logic.test.ts apps/web/src/components/RemoteUpdateRequestNotifier.test.tsx && vp run typecheck`
Expected: PASS and clean.

- [ ] **Step 5: Stop: the controller runs a Codex review and asks the user before committing.**

## Phase G — Live lane, documentation, gates, verification

### Task 17: The CI-only `remote-install` lane in the seeded upgrade smoke

**Never run `scripts/seeded-desktop-upgrade-smoke.ts` locally** (Global Constraints). This task edits the harness and proves it only with its unit tests and `node --check`; CI (`.github/workflows/desktop-upgrade-smoke.yml`, already under `xvfb-run` on Linux) runs the lane.

**Files:**
- Modify: `scripts/seeded-desktop-upgrade-smoke.ts`, `scripts/seeded-desktop-upgrade-smoke.test.ts`
- Create: `scripts/lib/remote-install-driver.ts` (+ `scripts/lib/remote-install-driver.test.ts`)
- Modify: `.github/workflows/desktop-upgrade-smoke.yml` only if the lane needs a new input or artifact name (it runs inside the existing per-target job)

**Interfaces:**
- `SeededUpgradeLane` gains `"remote-install"`; `SeededUpgradeRunLayout` gains `remoteInstall: SeededUpgradeLaneLayout` (`<runRoot>/remote`).
- New exported pure helpers (unit-tested):

```ts
/** Ports the lane must never use: the user's app, dev defaults and relay ports. */
export const REMOTE_INSTALL_FORBIDDEN_PORTS: ReadonlySet<number>; // 3773, 5733, 13773, 18431, 18432
export function assertRemoteInstallPort(port: number): number;
/** Live FUSE mounts of this lane's AppImage (by its `.mount_` prefix) in /proc/mounts text. */
export function countAppImageMounts(procMounts: string, mountPrefix: string): number;
export interface RemoteInstallEvidence {
  readonly before: { readonly bootId: string; readonly serverVersion: string; readonly storageInstanceId: string };
  readonly after: { readonly bootId: string; readonly serverVersion: string; readonly storageInstanceId: string };
  readonly phases: ReadonlyArray<string>;           // coordinator phases seen by the driver
  readonly sawPercent: boolean;
  readonly sawStage: boolean;
  readonly preUpdateBackups: number;
  readonly requesterLogLines: number;               // "remote update install requested" in server.log
  readonly appImageMounts: number | null;           // Linux only
  readonly runtimeProcesses: number | null;         // Linux only
}
export function verifyRemoteInstallOutcome(evidence: RemoteInstallEvidence, candidateVersion: string): void;
/** Linux cleanup scoped to this lane's BIBCODE_HOME via /proc/<pid>/environ, never `pkill -x`. */
export function scopedCleanupPids(
  processes: ReadonlyArray<{ readonly pid: number; readonly comm: string; readonly environ: string }>,
  bibcodeHome: string,
): ReadonlyArray<number>;
```

- `scripts/lib/remote-install-driver.ts` (first confirm that `node scripts/lib/remote-install-driver.ts` resolves `effect`, `@bibcode/contracts` and `@bibcode/shared/semver` when importing `../../packages/client-runtime/src/state/remoteUpdateCoordinator.ts` from the repository root; existing scripts already import `effect`. If the workspace packages do not resolve from `scripts/`, the driver implements a standalone follower with the same budgets and success rule and the task report says so): a Node driver that pairs over loopback plain `/ws` (bearer from the desktop bootstrap exchange, like `apps/server/tests/auth_http.rs`), implements `RemoteUpdatePort` over raw JSON RPC (`server.getConfig`, `updater.status`, `updater.install`, reconnect by re-opening the socket), reads `updater.activeWork`, and runs `runRemoteUpdate` from `packages/client-runtime/src/state/remoteUpdateCoordinator.ts`, returning `RemoteInstallEvidence` minus the host-side counts.

- [ ] **Step 1: Write the failing unit tests**

Append to `scripts/seeded-desktop-upgrade-smoke.test.ts`:

```ts
  it("keeps the remote-install lane on its own roots and away from reserved ports", () => {
    const layout = createSeededUpgradeRunLayout(absolute("work"), "run-17");
    expect(layout.remoteInstall.dataRoot).toBe(absolute("work", "run-17", "remote", "data"));
    expect(layout.remoteInstall.dataRoot).not.toBe(layout.protectedBaseline.dataRoot);
    for (const port of [3773, 5733, 13773, 18431, 18432]) {
      expect(() => assertRemoteInstallPort(port)).toThrow(SeededDesktopUpgradeSmokeError);
    }
    expect(assertRemoteInstallPort(43_180)).toBe(43_180);
  });

  it("counts only this lane's AppImage mounts", () => {
    const mounts = [
      "BiBCode-remote.AppImage /tmp/.mount_BiBCodRm1 fuse.BiBCode-remote.AppImage ro 0 0",
      "bibcode.AppImage /tmp/.mount_bibcodX2 fuse.bibcode.AppImage ro 0 0",
      "tmpfs /tmp tmpfs rw 0 0",
    ].join("\n");
    expect(countAppImageMounts(mounts, ".mount_BiBCodRm")).toBe(1);
  });

  it("requires a new boot on the candidate, the same storage, one backup, one log line and one runtime", () => {
    const good: RemoteInstallEvidence = {
      before: { bootId: "b1", serverVersion: "0.6.2", storageInstanceId: "s1" },
      after: { bootId: "b2", serverVersion: "0.6.3-upgrade.1", storageInstanceId: "s1" },
      phases: ["starting", "downloading", "installing", "restarting", "verifying", "succeeded"],
      sawPercent: true,
      sawStage: true,
      preUpdateBackups: 1,
      requesterLogLines: 1,
      appImageMounts: 1,
      runtimeProcesses: 1,
    };
    expect(() => verifyRemoteInstallOutcome(good, "0.6.3-upgrade.1")).not.toThrow();
    for (const broken of [
      { ...good, after: { ...good.after, bootId: "b1" } },
      { ...good, after: { ...good.after, serverVersion: "0.6.2" } },
      { ...good, after: { ...good.after, storageInstanceId: "s2" } },
      { ...good, preUpdateBackups: 0 },
      { ...good, requesterLogLines: 2 },
      { ...good, appImageMounts: 2 },
      { ...good, runtimeProcesses: 2 },
      { ...good, sawPercent: false },
    ]) {
      expect(() => verifyRemoteInstallOutcome(broken, "0.6.3-upgrade.1")).toThrow(
        SeededDesktopUpgradeSmokeError,
      );
    }
  });

  it("cleans up only processes that carry this lane's BIBCODE_HOME", () => {
    const home = "/tmp/work/run-17/remote/data";
    expect(
      scopedCleanupPids(
        [
          { pid: 10, comm: "bibcode-desktop", environ: `HOME=/home/u\0BIBCODE_HOME=${home}\0` },
          { pid: 11, comm: "bibcode-desktop", environ: "HOME=/home/u\0BIBCODE_HOME=/home/u/.bibcode\0" },
          { pid: 12, comm: "bibcode-desktop", environ: "HOME=/home/u\0" },
        ],
        home,
      ),
    ).toEqual([10]);
  });
```

Import the new names in the file's import list. Create `scripts/lib/remote-install-driver.test.ts` for the driver's pure helpers (no sockets): `encodeRequest(id, tag)` produces `{"_tag":"Request","id":…,"tag":…,"payload":{},"headers":[]}`; `decodeExit(message, id)` returns the success value or throws with the failure tag; `identityFromConfig(serverConfig)` maps `server.getConfig` to `RemoteUpdateServerIdentity` (`bootId`, `serverVersion`, `progress` from `capabilities.remoteUpdateProgress`, defaulting to `null`/`false` for an older server).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `vp test run scripts/seeded-desktop-upgrade-smoke.test.ts scripts/lib/remote-install-driver.test.ts`
Expected: FAIL — missing exports and module.

- [ ] **Step 3: Implement the helpers**

```ts
export const REMOTE_INSTALL_FORBIDDEN_PORTS: ReadonlySet<number> = new Set([3773, 5733, 13773, 18431, 18432]);

export function assertRemoteInstallPort(port: number): number {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || REMOTE_INSTALL_FORBIDDEN_PORTS.has(port)) {
    throw new SeededDesktopUpgradeSmokeError(`Port ${port} is reserved; pick a free high port for the remote-install lane.`);
  }
  return port;
}

export function countAppImageMounts(procMounts: string, mountPrefix: string): number {
  return procMounts
    .split("\n")
    .map((line) => line.split(" ")[1] ?? "")
    .filter((mountPoint) => NodePath.posix.basename(mountPoint).startsWith(mountPrefix)).length;
}

export function verifyRemoteInstallOutcome(evidence: RemoteInstallEvidence, candidateVersion: string): void {
  const fail = (message: string): never => {
    throw new SeededDesktopUpgradeSmokeError(`remote-install: ${message}`);
  };
  if (evidence.after.bootId === evidence.before.bootId) fail("the host did not restart (same bootId).");
  if (evidence.after.serverVersion !== candidateVersion) fail(`the host runs ${evidence.after.serverVersion}, not ${candidateVersion}.`);
  if (evidence.after.storageInstanceId !== evidence.before.storageInstanceId) fail("the storage identity changed.");
  if (!evidence.sawPercent || !evidence.sawStage) fail("the client never saw a download percent and a protection stage.");
  if (!evidence.phases.includes("succeeded")) fail("the coordinator did not report success.");
  if (evidence.preUpdateBackups < 1) fail("no verified pre-update backup was retained.");
  if (evidence.requesterLogLines !== 1) fail(`expected one requester log line, found ${evidence.requesterLogLines}.`);
  if (evidence.appImageMounts !== null && evidence.appImageMounts !== 1) fail(`expected one AppImage mount, found ${evidence.appImageMounts}.`);
  if (evidence.runtimeProcesses !== null && evidence.runtimeProcesses !== 1) fail(`expected one AppImage runtime, found ${evidence.runtimeProcesses}.`);
}

export function scopedCleanupPids(
  processes: ReadonlyArray<{ readonly pid: number; readonly comm: string; readonly environ: string }>,
  bibcodeHome: string,
): ReadonlyArray<number> {
  return processes
    .filter((entry) => entry.environ.split("\0").includes(`BIBCODE_HOME=${bibcodeHome}`))
    .map((entry) => entry.pid);
}
```

`createSeededUpgradeRunLayout` adds `remoteInstall: laneLayout(runRoot, "remote")`; `copyBoundedEvidence`'s `lanes` array adds `["remote-install", input.layout.remoteInstall]`.

- [ ] **Step 4: Implement the lane**

In `runSeededDesktopUpgradeSmoke`, after the protected-baseline lane and reusing its baseline build (same current-source baseline, lower version, overlay identifier, ephemeral updater key, loopback mock feed):

1. Install the baseline into `layout.remoteInstall` under an AppImage file name whose `.mount_` prefix is not `bibcod` (e.g. `RemoteLane.AppImage`), with its own `BIBCODE_HOME=layout.remoteInstall.dataRoot` and `BIBCODE_PORT=assertRemoteInstallPort(<free port>)`, and the runbook's Xvfb and XDG isolation (`docs/testing/linux-desktop.md` "Remote server updates" / AppImage section).
2. In a WebDriver phase, widen the primary the way the spec does — by a live **Another device** grant, not a raw exposure call (exposure is grant-driven; `ShareExposureReconciler` in `apps/web/src/AppRoot.tsx` would narrow an ungranted widen back). Navigate the WebView to `/settings/remote-servers?tab=share`, keep the default **Another device** intent, click **Generate pairing offer** (`ShareThisHostTab.tsx`), and wait until `ss -ltn` shows the port on `0.0.0.0`. After the update restart, the replacement starts loopback-only until the reconciler sees the grant and widens again (spec Risks); the driver must reach only the wide boot. If the widen does not appear within 60 s, record `widened: false` and continue on loopback; the report must then say the wide leg rests on `production_maintenance.rs` and the desktop transport test (spec "Not verified live").
3. Run `scripts/lib/remote-install-driver.ts` against `127.0.0.1:<port>` with the desktop bootstrap token from the lane's launch environment (never logged; add it to `secrets`). The driver reads `updater.activeWork` (expects zeros), runs the coordinator, and writes its evidence JSON into `layout.remoteInstall.evidenceDirectory`.
4. After the restart, read `/proc/mounts` for the lane's `.mount_` prefix and count runtime processes by `scopedCleanupPids` over `/proc/*/environ` (Linux only; `null` elsewhere); count "remote update install requested" in `<dataRoot>/userdata/logs/server.log`; inventory pre-update backups through the existing public-boundary WebDriver observation (never open SQLite directly).
5. `verifyRemoteInstallOutcome(evidence, candidateVersion)`.
6. Cleanup: on Linux, `SIGTERM` exactly `scopedCleanupPids(…)` for this lane's home instead of `restartedApplicationCleanupPlan`'s `pkill -x`; keep the existing plan for the other lanes unchanged.

- [ ] **Step 5: Run the unit tests and syntax checks (never the harness)**

Run: `vp test run scripts/seeded-desktop-upgrade-smoke.test.ts scripts/lib/remote-install-driver.test.ts && node --check scripts/seeded-desktop-upgrade-smoke.ts && node --check scripts/lib/remote-install-driver.ts`
Expected: PASS; `node --check` exits 0 (Node strips types; if it cannot parse TS on this Node, run `vp exec tsc --noEmit -p scripts` or the repository's script typecheck from `docs/reference/scripts.md` instead).

- [ ] **Step 6: Stop: the controller runs a Codex review and asks the user before committing.** Tell the controller the lane is validated only by unit tests until a CI run of `desktop-upgrade-smoke.yml`.

### Task 18: Living documentation and testing runbooks

**Files (targeted `Edit`s to your own paragraphs; several files carry other agents' edits):**
- `docs/architecture/remote.md` — "Remote server updates"
- `docs/architecture/overview.md` — "Desktop update protection", "Remote server updates", the relaunch descriptor rule (AppImage section)
- `docs/architecture/connection-runtime.md` — "Data boundary", "State and retry policy"
- `docs/user/remote-access.md` — new "Update a remote server" section
- `docs/user/server-installation.md` — note that the client shows kind-specific steps (one sentence)
- `docs/operations/observability.md` — the requester log line
- `docs/operations/release.md` — "Seeded packaged-upgrade matrix"
- `docs/operations/ci.md` — the `desktop-upgrade-smoke.yml` line
- `docs/testing/linux-desktop.md`, `docs/testing/macos-desktop.md`, `docs/testing/windows-desktop.md` — "Remote server updates" scenarios; Linux AppImage stale-runtime check
- `docs/testing/cross-platform-validation.md` — the matrix row for remote updates, if it lists scenarios
- `docs/reference/scripts.md` — the fake host example (Task 20) and the harness's new lane

- [ ] **Step 1: `remote.md`**

In "Remote server updates":
- Extend the snapshot description with `downloadPercent`, `targetVersion`, `installStage` (decode-defaulted; unknown stages get a generic label), `support.installKind` (`archive`, `system-package`, `unknown`), and the descriptor's `bootId` and `remoteUpdateProgress` capability. State that no new `RemoteUpdateState` literal was added and why.
- Add `updater.activeWork` (`orchestration:read`, counts across all clients, its own read method so the one-second status poll never waits on the store).
- Describe the coordinator (`packages/client-runtime/src/state/remoteUpdateCoordinator.ts` + the run family in `remoteUpdates.ts`): one single-flight run per environment, at most two at once (third **Queued**), owned by the Atom runtime, following `EnvironmentRegistry.stateChanges` with no effect spanning the restart; the budgets (10 s reads, 30 s install, 10 min download, 2 min install, 3 min restart, `retryNow` at most every 5 s); success by `bootId` and version; failure by the host's `error` on any connected generation; the legacy (no capability) rule; the status query is not observed while a run is active.
- Describe the host notice (`requestedBy` on `desktop:update-state`, once per install, **Manage devices**), the operational log line, and the browser reload prompt (never reloads by itself).
- Replace the "Known gap" sentence about the first status read after install (the coordinator follows the flow now).
- In "Share ceremony and exposure", replace the paragraph "A wide-bound native primary does not expose the desktop-only maintenance API. Update protection therefore degrades while sharing…" with: the HTTP maintenance API stays hidden on a wide bind, but the desktop protects its in-process primary directly (`ServerHandle::update_maintenance`), so update protection is unchanged while sharing.

- [ ] **Step 2: `overview.md`**

- "Desktop update protection": after "Each included backend exposes an authenticated maintenance API only in desktop mode…", add that every desktop-mode runtime with a bootstrap token owns the maintenance coordinator whatever its bind; the host calls it in process for the primary (same 45 s / 250 ms / 10 s bounds, same error text through `MaintenanceError::http_status_code`, exit after commit or cancel) and over the loopback HTTP API for WSL and external backends. The HTTP invariant (loopback, or WSL-owned wildcard) is unchanged.
- "Remote server updates": the new fields, `updater.activeWork`, `bootId` from all three descriptor producers, the requester seam (`register_unary_with_context` → `AuthService::list_clients` → `request_install(requester)`; never `DesktopBridge`).
- AppImage section: before `app.restart()` the host marks descriptors above 2 close-on-exec (`relaunch.rs`), so an update relaunch no longer keeps the old type-2 runtime, its FUSE mount and the replaced AppImage alive. Residuals from the spec (inherited environment; stale `.mount_` entries behind the new mount) stay documented.

- [ ] **Step 3: `connection-runtime.md`**

- "Data boundary": `bootId` is per server start, never persisted, never part of storage identity or accepted-identity checks.
- "State and retry policy": a remote update run may call `retryNow` at most every 5 s during its 3-minute restart budget; it never creates supervisors or changes desired intent.

- [ ] **Step 4: User docs**

`docs/user/remote-access.md`, new section "Update a remote server": **Update to v…** on the card or in Settings → Remote Servers; the confirmation and what stops versus what is kept; progress labels; the three failure messages and what to do (for "may be on a different port": check BiBCode on the host, re-pair if its port changed); the host shows who asked and **Manage devices** revokes; headless servers use **Show update steps**; the browser page shows a **Reload** prompt when its own server was updated. `docs/user/server-installation.md`: one sentence that BiBCode shows these steps per install kind under **Show update steps**.

- [ ] **Step 5: Operations docs**

- `observability.md` "Logs": the `remote update install requested` info line (label, OS, address, 8-character session prefix, versions; no credentials) and its failure `warn`.
- `release.md` "Seeded packaged-upgrade matrix" and `ci.md`: the `remote-install` lane (what it asserts, that it runs in CI, that locally it must only run on a host in isolation — cgroup or `BIBCODE_HOME` scoping — and never on a machine running the user's BiBCode).

- [ ] **Step 6: Runbooks**

In each of `docs/testing/{linux,macos,windows}-desktop.md`, replace the "Remote server updates" bullet's last sentence with scenarios that match current behavior:
- a desktop-hosted release build as the second server, shared with **Another device**: **Update to v…** opens the confirmation with counts (open a terminal on it first and confirm "1 terminal will stop"); confirm and watch **Downloading N%**, **Backing up project data…**, **Restarting…**, **Checking the new version…**, **Updated to v…** and the toast; on the host, the notice names the device and **Manage devices** opens Share this host;
- a failure (disconnect the host's network during the restart for more than 3 minutes → "hasn't come back"); a manual host shows **Show update steps** with kind-specific commands and **Copy**;
- browser mode: update the page's own server from another client and confirm the **Reload** prompt appears and typed composer text survives until **Reload**.
Linux only, AppImage section: after an update relaunch, `grep -c "$(basename "$APPIMAGE" .AppImage | cut -c1-6)" /proc/mounts`-style check that exactly one `.mount_` for this AppImage and one runtime remain (write the exact command against the runbook's existing AppImage variables).
Windows: note that a WSL secondary that fails protection cannot be excluded remotely; the error says to finish on the host.

Execution-specific SHAs, versions, timings and paths belong in reports, not in these runbooks.

- [ ] **Step 7: Check links and formatting**

Run: `vp check`
Expected: clean (the docs are covered by the formatter).

- [ ] **Step 8: Stop: the controller runs a Codex review and asks the user before committing.**

### Task 19: Gates

- [ ] **Step 1: Contracts (temporary index)**

Run the Task 4 Step 7 block verbatim.
Expected: exit **0**; report `check:contracts: PASS (exit 0, temporary fixture index)`.

- [ ] **Step 2: TypeScript**

Run: `vp check` then `vp run typecheck`
Expected: both exit 0.

- [ ] **Step 3: TypeScript tests for changed packages**

Run: `vp test run packages/contracts packages/client-runtime/src/state apps/web/src/components/settings apps/web/src/components/sidebar apps/web/src/components/RemoteUpdateRequestNotifier.test.tsx apps/web/src/serverReload.logic.test.ts apps/web/src/components/Sidebar.test.tsx apps/web/src/tauriDesktopBridge.test.ts scripts/seeded-desktop-upgrade-smoke.test.ts scripts/lib/remote-install-driver.test.ts`
Expected: PASS.

- [ ] **Step 4: Rust**

Run:
- `cargo fmt --all --check`
- `cargo clippy -p bibcode-server --all-targets -- -D warnings`
- `cargo clippy -p bibcode-desktop --all-targets -- -D warnings`
- `cargo test -p bibcode-server --test production_maintenance --test remote_update_rpc --test rpc_wire --test static_assets --test repositories`
- `cargo test -p bibcode-server --lib remote_update auth::scope terminal::manager rpc::session`
- `cargo test -p bibcode-desktop --lib`

Expected: all pass. Classify any `provider_terminal_supervisor` or pipe-budget failure with a focused re-run (Global Constraints); do not chase known host flakes.

- [ ] **Step 5: Record**

Write every command and its result in the ledger. Do not continue to Task 20 with a red gate that this plan caused.

- [ ] **Step 6: Stop: the controller runs a Codex review and asks the user before committing.**

### Task 20: Live Playwright verification against a local fake host

No real remote server, never port 3773, never the user's `bibcode-desktop`. The dev desktop build is always `manual` (`derive_remote_update_support` under `debug_assertions`), so the interactive UI states come from a **fake host**: a real server started from an example binary with a scripted `RemoteUpdateDelegate`. The real protect → install → restart path is covered by Tasks 1–3 and 8 (Rust) and the CI lane (Task 17); say so in the report.

**Files:**
- Create: `apps/server/examples/remote_update_fake_host.rs`
- Scratch only (never in the repository): `$LIVE/drive.mjs`, `$LIVE/logs/*`, `$LIVE/shots/*`

- [ ] **Step 1: Write the fake host**

`apps/server/examples/remote_update_fake_host.rs` (public API only; reads JSON commands on stdin, one per line):

```rust
//! Live-check fake host for remote server updates. Not shipped.
//!
//! Usage: cargo run -p bibcode-server --example remote_update_fake_host -- \
//!   <base-dir> <bind-ip> <port> <server-version> [label, default "Fake-host"]
//! Prints one JSON line {"pairingLink": …, "pairingUrl": …, "port": …} per start (both
//! carry credentials: the driver must not log them). Commands on stdin, one JSON object per line:
//!   {"status": {"state": "downloading", "latestVersion": "9.9.1", "targetVersion": "9.9.1",
//!               "downloadPercent": 42, "installStage": null, "error": null}}
//!   {"restart": {"serverVersion": "9.9.1", "afterMs": 3000}}   // new boot, same data root
//!   {"stop": true}                                              // host never comes back
use std::{
    io::BufRead,
    sync::{Arc, Mutex},
};

use bibcode_server::{
    HostUpdaterFuture, HostUpdaterStatus, RemoteUpdateDelegate, RemoteUpdateInstallKind,
    RemoteUpdateInstallMode, RemoteUpdateRequester, RemoteUpdateState, RemoteUpdateSupport,
    RemoteUpdateSupportReason, ServerConfig, ServerRuntime,
    diagnostics::UnavailableDesktopUiProcessObserver,
};
use serde::Deserialize;

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScriptedStatus {
    state: Option<String>,
    latest_version: Option<String>,
    target_version: Option<String>,
    download_percent: Option<u8>,
    install_stage: Option<String>,
    error: Option<String>,
}

struct ScriptedDelegate(Arc<Mutex<ScriptedStatus>>);

impl ScriptedDelegate {
    fn current(&self) -> HostUpdaterStatus {
        let status = self.0.lock().expect("scripted status").clone();
        let state = match status.state.as_deref() {
            Some("checking") => RemoteUpdateState::Checking,
            Some("update-available") => RemoteUpdateState::UpdateAvailable,
            Some("downloading") => RemoteUpdateState::Downloading,
            Some("installing") => RemoteUpdateState::Installing,
            Some("up-to-date") => RemoteUpdateState::UpToDate,
            Some("error") => RemoteUpdateState::Error,
            _ => RemoteUpdateState::Idle,
        };
        HostUpdaterStatus {
            latest_version: status.latest_version,
            state,
            error: status.error,
            download_percent: status.download_percent,
            target_version: status.target_version,
            install_stage: status.install_stage,
        }
    }
}

impl RemoteUpdateDelegate for ScriptedDelegate {
    fn status(&self) -> HostUpdaterFuture {
        let status = self.current();
        Box::pin(async move { status })
    }
    fn check(&self) -> HostUpdaterFuture {
        self.status()
    }
    fn request_install(&self, requester: RemoteUpdateRequester) -> HostUpdaterFuture {
        eprintln!("install requested by {:?}", requester.label);
        self.status()
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let base_dir = args.next().ok_or("missing base-dir")?;
    let bind_ip = args.next().ok_or("missing bind-ip")?;
    let port: u16 = args.next().ok_or("missing port")?.parse()?;
    let mut version = args.next().ok_or("missing server-version")?;
    let label = args.next().unwrap_or_else(|| "Fake-host".to_owned());
    let status = Arc::new(Mutex::new(ScriptedStatus {
        state: Some("update-available".to_owned()),
        latest_version: Some("9.9.1".to_owned()),
        target_version: Some("9.9.1".to_owned()),
        ..ScriptedStatus::default()
    }));
    let (commands_tx, mut commands) = tokio::sync::mpsc::unbounded_channel::<serde_json::Value>();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines().map_while(Result::ok) {
            if let Ok(value) = serde_json::from_str(&line) {
                let _ = commands_tx.send(value);
            }
        }
    });
    loop {
        let mut config = ServerConfig::new(&base_dir)
            .with_bind(bind_ip.clone(), port)
            .with_remote_update_support(RemoteUpdateSupport {
                install_mode: RemoteUpdateInstallMode::Interactive,
                reason: RemoteUpdateSupportReason::Available,
                install_kind: RemoteUpdateInstallKind::Unknown,
            });
        config.server_version = version.clone();
        config.environment_label = label.clone();
        let handle = ServerRuntime::start_with_desktop_integration(
            config,
            Arc::new(UnavailableDesktopUiProcessObserver),
            Arc::new(ScriptedDelegate(status.clone())),
        )
        .await?;
        println!(
            "{}",
            serde_json::json!({
                "port": handle.local_addr().port(),
                "pairingLink": handle.startup_access().and_then(|access| access.pairing_link.clone()),
                "pairingUrl": handle.startup_access().map(|access| access.pairing_url.clone()),
            })
        );
        let next = loop {
            let Some(command) = commands.recv().await else { return Ok(()) };
            if let Some(update) = command.get("status") {
                *status.lock().expect("scripted status") = serde_json::from_value(update.clone())?;
            } else if let Some(restart) = command.get("restart") {
                break Some(restart.clone());
            } else if command.get("stop").is_some() {
                break None;
            }
        };
        handle.shutdown();
        handle.join().await?;
        let Some(restart) = next else {
            // "stop": the host never comes back; keep the process for the driver to kill.
            std::future::pending::<()>().await;
            return Ok(());
        };
        tokio::time::sleep(std::time::Duration::from_millis(
            restart["afterMs"].as_u64().unwrap_or(2_000),
        ))
        .await;
        version = restart["serverVersion"].as_str().unwrap_or(&version).to_owned();
        *status.lock().expect("scripted status") = ScriptedStatus {
            state: Some("idle".to_owned()),
            ..ScriptedStatus::default()
        };
    }
}
```

Check before compiling: `bibcode_server::diagnostics::UnavailableDesktopUiProcessObserver` is the path `tests/remote_update_rpc.rs` uses; `serde` with `derive` is a normal dependency of `bibcode-server` (examples may use it); `startup_access()` returns the pairing link only for a routable specific bind (`startup_offer_endpoint`), which is why the fake host binds a non-loopback address (open question 4). Build: `cargo build -p bibcode-server --example remote_update_fake_host`. Lint it with the crate's clippy gate.

- [ ] **Step 2: Start the isolated dev server and the fake host**

```bash
S=/tmp/claude-1000/-work-workspaces-orca-BibCode-main-3/2c4f97f1-0ee1-4c37-b2bb-432255e2f351/scratchpad
LIVE=$S/remote-updates-live; mkdir -p $LIVE/logs $LIVE/shots $LIVE/home $LIVE/fake-home
cd /work/workspaces/orca/BibCode/main-3
# Offset 93: server 13866, web 5826 (13773/5733 + 93). Never 3773.
BIBCODE_PORT_OFFSET=93 BIBCODE_HOME=$LIVE/home setsid vp run dev > $LIVE/logs/dev.log 2>&1 &
echo $! > $LIVE/logs/dev.pid
HOST_IP=$(ip -4 route get 1.1.1.1 | awk '{for (i=1;i<NF;i++) if ($i=="src") print $(i+1)}')
mkfifo $LIVE/fake.stdin
( tail -f $LIVE/fake.stdin | setsid cargo run -q -p bibcode-server --example remote_update_fake_host -- \
    $LIVE/fake-home "$HOST_IP" 13991 0.6.2 > $LIVE/logs/fake.out 2> $LIVE/logs/fake.err ) &
echo $! > $LIVE/logs/fake.pid
```

Wait for `serverPort=13866 webPort=5826` and the startup token line in `dev.log` (save the token to `$LIVE/.token` without printing it, as the liveness plan does), and for the JSON line in `fake.out` (save `pairingLink` to `$LIVE/.fake-link`, never print it). Port 13991 is outside every forbidden port.

- [ ] **Step 3: Write the Playwright driver**

`$LIVE/drive.mjs` (resolve `playwright` through the link the liveness live checks use under `$S`; if absent, `npm exec --yes playwright@<repo version>` into `$LIVE/node_modules`). It:
1. opens `http://localhost:5826/`, pairs with `$LIVE/.token` through `/pair`, and adds the fake host through **Add Server** with `$LIVE/.fake-link`;
2. selects **Fake-host** in the rail and walks the states below, writing one screenshot per state to `$LIVE/shots/<n>-<state>.png` and one JSON line per assertion to `$LIVE/results.jsonl`;
3. drives the fake host by appending JSON lines to `$LIVE/fake.stdin`.

States and assertions (each an explicit `expect(page.getByText(…)).toBeVisible()` with a 15 s timeout):

| # | Fake-host command | Where | Expect |
| --- | --- | --- | --- |
| 1 | initial (`update-available`, 9.9.1) | card and Settings row | **Update to v9.9.1…** |
| 2 | click it | dialog | "Updating Fake-host restarts BiBCode there.", "Nothing is running on it now.", "v9.9.1 is newer than this app (v…). Update this app too.", buttons **Update Fake-host** and **Cancel**; **Cancel** closes without a request (no "install requested" line in `fake.err`) |
| 3 | open a terminal on Fake-host, then the dialog again | dialog | "1 terminal will stop. Conversations and queued messages are kept, and agents continue when you send the next message." |
| 4 | confirm; `{"status":{"state":"downloading","downloadPercent":42,"targetVersion":"9.9.1","latestVersion":"9.9.1"}}` | card and row | **Downloading 42%**; `fake.err` shows exactly one "install requested" line |
| 5 | `{"status":{"state":"installing","installStage":"creating-verified-backup","targetVersion":"9.9.1"}}` | card and row | **Backing up project data…** |
| 6 | `{"restart":{"serverVersion":"9.9.1","afterMs":8000}}` | card and row | **Restarting…**, then **Checking the new version…** (may be brief; accept either order within 15 s), then **Updated to v9.9.1** and the success toast |
| 7 | fresh run: restart the fake host at 0.6.2 with status `update-available`; confirm; `{"status":{"state":"error","error":"Signature mismatch"}}` | row and toast | "Couldn't update Fake-host: Signature mismatch. Nothing was installed; it runs v0.6.2 again." with **Retry** |
| 8 | **Retry**; `{"restart":{"serverVersion":"0.6.2","afterMs":3000}}` with status `idle` | row and toast | "Fake-host restarted on v0.6.2 instead of v9.9.1." |
| 9 | **Retry**; `{"stop":true}` | row and toast | after 3 minutes, "Fake-host hasn't come back after the update. Check BiBCode on Fake-host; it may be on a different port." |
| 10 | two more fake hosts (`$LIVE/fake2-home … 13992 0.6.2 Fake-host-2`, `$LIVE/fake3-home … 13993 0.6.2 Fake-host-3`) with a slow scripted `downloading` status; confirm all three within a second | rows | two progress labels and one **Queued**; the queued one starts when a run ends |
| 11 | a headless `bibcode serve` second server (`cargo run -p bibcode-server -- serve --host "$HOST_IP" --port 13994 --base-dir $LIVE/headless-home`), added by its pairing link | card menu and row | **Show update steps** (card menu, instead of **Check for updates**) opens the steps with **Copy**; the row's steps block matches the host's OS/arch |
| 12 | browser mode: a fourth fake host on `127.0.0.1:13867` (`… remote_update_fake_host -- $LIVE/page-home 127.0.0.1 13867 0.6.2`) as the **page's own server**, served to a second page by `BIBCODE_PORT_OFFSET=94 vp run dev:web` (web 5827, server 13867); pair that page through the fake host's `pairingUrl`; set `window.__noReload = true`; send `{"restart":{"serverVersion":"9.9.1","afterMs":2000}}` | second page | "BiBCode on this server was updated to v9.9.1. Reload to use it." with **Reload**; `window.__noReload` is still `true` 10 s later (no automatic reload); clicking **Reload** reloads |
| 13 | host notice | — | not reachable live: a dev desktop is always `manual`, so no install reaches its delegate (open question 6); covered by Task 8 and Task 16 tests |

For each state also check there is no console error (`page.on("console")` collecting `error`), and that no request went to port 3773 (`page.on("request")`).

- [ ] **Step 4: Run and collect**

The controller runs `node $LIVE/drive.mjs` on the host (loopback binding may be denied in sandboxes). Expected: rows 1–12 pass; screenshots exist for each. Row 13 is reported as not run live.

- [ ] **Step 5: Clean up only what you started**

`kill -- -$(cat $LIVE/logs/dev.pid)`, `kill -- -$(cat $LIVE/logs/fake.pid)` and the other fake-host/headless pids you recorded; `rm $LIVE/fake.stdin`. Never `pkill` by name.

- [ ] **Step 6: Stop: the controller runs a Codex review and asks the user before committing.**

### Task 21: UI reviews and final diff review

- [ ] **Step 1: `vercel-react-best-practices` review**

Invoke the `vercel-react-best-practices` skill and review every changed component and hook: `ServerUpdateBadge.tsx`, `UpdateServerDialog.tsx`, `ManualUpdateStepsDialog.tsx`, `ConnectTab.tsx` (`RemoteServerRow`, `RemoteServerRowFromSession`), `EnvironmentContextCard.tsx`, `Sidebar.tsx` (`SidebarEnvironmentContextCard`), `RemoteUpdateRequestNotifier.tsx`, `ServerReloadPrompt.tsx`, `apps/web/src/state/remoteUpdates.ts`. Check at least: no state derived in effects that could be computed in render; stable callbacks passed to memoized children; the dialog's `activeWork` query mounts only while open; no re-render loop from the run atom; the ref write in `ServerReloadPrompt` (move to state if the review objects). Fix findings, re-run Task 19 Step 3.

- [ ] **Step 2: `UI.md` review**

Review the same surfaces against `UI.md`: the confirmation names the action (**Update {name}**, not OK) and explains the consequence briefly; the default is safe (always confirm); progress replaces the action so it cannot be clicked twice; disabled **Check** during a run is explained by the visible progress label; each failure says what failed and what to do, with **Retry**; the reload prompt preserves unsent text; the host notice is informative and actionable (**Manage devices**); text sizes stay at `text-xs` or larger with solid `text-muted-foreground`. Record the Retry-without-reconfirm decision (Task 13) for the reviewer. Fix findings.

- [ ] **Step 3: Final diff and status review**

Run: `git status --short` and `git diff --stat`, then `git diff` for every file this plan touched.
Check: no edits outside the plan's files (other agents' changes are theirs); no generated files other than the regenerated `packages/contracts/fixtures/rpc-wire/**`; no debug output, no `console.log`, no committed secrets or tokens; no dependency drift (`git diff -- '**/package.json' '**/Cargo.toml' Cargo.lock pnpm-lock.yaml` shows only intended changes, ideally none); the docs from Task 18 are present. Report the exact validation commands, anything that could not run (the CI lane until its first CI run; the host notice live check, open question 6), and residual risk.

- [ ] **Step 4: Stop: the controller runs a Codex review and asks the user before committing.**

## Self-review

**Spec coverage** (spec section → task):

| Spec requirement | Task |
| --- | --- |
| §1a in-process protection; HTTP still 404 on a wildcard bind; owner on `ServerHandle`; handle on `BackendUpdateSnapshot`; same bounds, error text, exit on cancel | 1, 2 |
| §1a `remote.md:651-654` gap retires | 18 (Step 1) |
| §2 `downloadPercent`, `targetVersion`, `installStage`; `installKind`; decode defaults; no new state literal | 4 |
| §2 `bootId` on every descriptor producer, never persisted; `remoteUpdateProgress` capability | 5 |
| §2 `updater.activeWork` (read, `orchestration:read`, across clients); wire manifest, typed failures, counts | 6 |
| §2 new `contract-shapes/updater__status-success.json` round-tripped through Rust | 4 (Step 6) |
| §2 / §4 `request_install` takes a requester; `FixtureDelegate` and the production delegate change | 7, 8 |
| §2 `DesktopUpdateState.requestedBy` | 8 |
| §3 coordinator: single-flight per environment, Atom-owned, two at once + **Queued**, no effect across the restart, 10 s reads, budgets, 5 s retry, success rule, failure probe adapted, legacy rule | 9, 10 |
| §3 status query not observed during a run | 13, 14 |
| §4 host toast once per install, **Manage devices**; server→host seam, never `DesktopBridge` | 8, 16 |
| §4 operational log line + failure `warn` | 7, 8 |
| §5 close-on-exec before `app.restart()`, `/proc/self/fd` fallback | 3 |
| UI: **Update to v{latest}…** on card and row | 12, 13, 14 |
| UI: confirmation with counts and every variant, **Update {name}** / **Cancel**, always confirm | 12, 13 |
| UI: progress labels, **Updated to v…** + toast | 12, 13, 14 |
| UI: three failure messages as toast and in the row, with **Retry** | 12, 13 |
| UI: browser-mode reload prompt, never automatic | 16 |
| UI: **Show update steps** per `installKind`, OS/arch, SSH-launched, **Copy** | 15 |
| Validation: server, desktop, client-runtime, web, contracts tests | 1–16 |
| Validation: live `remote-install` lane (CI only here) | 17 |
| Living docs and runbooks | 18 |
| Gates, live Playwright, React and UI.md reviews | 19, 20, 21 |
| R3 sticky port | out of scope (spec: "a small separate change") |

**Placeholder scan:** every code step has code; test steps name the harness they reuse where the existing file's helpers must be read first (ConnectTab, Sidebar, repositories), and give the full new test body.

**Type consistency:** `RemoteUpdateRunState` / `RemoteUpdateFailure` / `RemoteUpdatePort` (Task 9) are the only run types used by Tasks 10–17; `UpdateServerRequest` (Task 13) is reused by Task 14; `RemoteUpdateRequester` (Task 7) by Tasks 8 and 20; `UpdateProtectionTransport` / `MaintenanceFinish` (Task 2) are desktop-internal; `ServerHandle::update_maintenance()` (Task 1) feeds Task 2.

## Open questions for the controller

1. **Confirmation variant vs reload prompt.** The spec's confirmation variant "This page reloads when {name} is back." promises an automatic reload, while the browser-mode prompt "never reloads by itself, so unsent text survives". Also, no current UI path updates the page's own server: the card is hidden for the primary and Settings rows list saved remotes, so `servesThisPage` is always `false` in this plan and the variant never shows. Ruling needed: drop the variant, reword it (for example "This page offers a reload when {name} is back."), or add an entry point for the page's own server.
2. **Error text across transports.** The plan keeps in-process protection errors byte-identical to the HTTP ones by mapping `MaintenanceError` through the same 409/503 table (`http_status_code`), so the message still says "(HTTP 409)" in process. Confirm, or rule a transport-neutral wording for both.
3. **Integer percent.** `downloadPercent` is carried as an integer 0–100 (floor) in Rust so `HostUpdaterStatus`/`RemoteUpdateSnapshot` keep `Eq`; the wire type stays `number | null`. Confirm.
4. **Fake host bind.** The live check's fake host binds this machine's non-loopback address on port 13991–13994 because the server mints a startup pairing link only for a routable specific bind (`startup_offer_endpoint`). That exposes token-protected test ports on the LAN for the duration. Accept, or choose another pairing path (for example a test-only pairing-link printer in the example).
5. **Device address.** The spec's notice and log name the requester's address, but `ClientMetadata.ip_address` is never populated (`apps/server/src/auth/http.rs::client_metadata` sets `ip_address: None`), so the notice reads "BiBCode Desktop on MacIntel is installing…" and the log's address is "unknown". Options: thread the WebSocket peer address (`ConnectInfo<SocketAddr>`, already in the router) into `RpcSessionContext` and use it when no stored address exists (a relay or E2EE connection would show the relay), or accept OS-only. The plan implements metadata-only.
6. **Host notice live check.** A dev desktop is always `manual` (`derive_remote_update_support` under `debug_assertions`), so no install reaches its delegate and the toast cannot be seen live without a release build. The plan covers it with Task 8 and Task 16 tests and reports it as not run live. Accept, or ask for a release-build check (which would need the seeded harness, banned locally).
7. **Track B collision.** Tasks 8, 14 and 15 must edit files the left-panel plan owns (`Sidebar.tsx` `SidebarEnvironmentContextCard`, `sidebar/EnvironmentContextCard.tsx`, `sidebar/environmentContextCard.logic.ts`, `packages/contracts/src/ipc.ts` `DesktopUpdateState`). Sequence these tasks after track B lands, or approve targeted edits.
8. **Unworded copy.** The spec does not word: the dialog title ("Update {name} to v{target}?"), the pending counts line ("Counting running work…"), toasts for up to date ("{name} is already up to date") and failure title ("Update failed"), the success toast title ("{name} updated to v…"), and failure messages for a download over 10 minutes, an install over 2 minutes, a rejected install request, an unreadable server before the run, and a manual host. Approve the plan's wording (Tasks 12, 16) or supply copy.
9. **Where `bootId` is published.** The spec says `bootId` "also goes wherever `storageInstanceId` is published". Besides the three descriptors, `storageInstanceId` appears in the `e2ee_authenticated` reply (`apps/server/src/rpc/e2ee.rs`) and in pairing-code payloads (`auth/http.rs`, `auth/pairing_code.rs`), which are shareable credentials the client stores. The plan adds `bootId` to the descriptors only (all the coordinator reads). Confirm, or name the other places.
10. **Retry without re-confirming.** After a failed run, **Retry** (row and toast) starts a new run without showing the confirmation again. Confirm this against UI.md's "always confirm", or require the dialog on Retry.
11. **Live seeded lane.** The spec wants the `remote-install` lane run in CI and optionally on Ai-server in isolation. This plan writes it and runs only its unit tests; the first real run is CI. Confirm that is enough for this change.
12. **Rail polling during a run.** The environment rail keeps observing `updater.status` for its amber dot (2.5 s while busy), so "the status query … does not poll alongside it" holds for the card and the Settings row only. Accept, or have the rail read the run state too (a track B file).
13. **WSL wording.** The spec's Risks say a WSL secondary that fails protection "cannot be excluded remotely … so the error says to finish on the host". Today the host message is `apply_named_secondary_exclusions`' sentence ("…must be protected or explicitly excluded by name."). No task rewords it; rule whether a remote install should append "Finish the update on the host." (a `run_remote_install` change) or keep the host's sentence.

## Controller rulings on the open questions (2026-09-25)

These rulings bind the implementer. The user may override any of them; the report must list them.

1. **Drop the "This page reloads when {name} is back." variant.** No UI path reaches it (`servesThisPage` is always `false`), and it contradicts the browser-mode rule that the page never reloads by itself. Do not implement it. Record the removal in the spec's refinement notes. If an entry point for the page's own server is added later, it needs a reworded variant such as "Reload this page when {name} is back."
2. **Transport-neutral error text.** User-visible messages must not include transport details such as "(HTTP 409)". Both transports share one message text, and HTTP keeps its status code only as the response status. Update the affected tests.
3. **Integer percent: confirmed.**
4. **The fake host binds loopback only.** Never bind a LAN address. Pair through `bibcode pairing issue --base-dir <fake home> --json`, the headless pairing CLI that the SSH flow already uses against a loopback server, or through a test-only pairing-link printer in the example.
5. **Device address: metadata only for this change.** When no address is known, leave the address out of user-visible copy; never show "unknown". The log may say "address unknown". Passing the WebSocket peer address through is a possible follow-up; do not do it here.
6. **Host notice: covered by tests only.** Accepted. Report it as not run live.
7. **Track B collision.** This plan runs after the left-panel change lands, which is already the scheduled order. Re-check every edit to `Sidebar.tsx`, `sidebar/*` and `ipc.ts` against the post-track-B source before editing.
8. **Copy: the plan's wording is approved**, with one correction. "Nothing was installed; it runs v{old} again." may only appear when the client has evidence for it: the host reported the failure before installing, or the server answers on the old version with an unchanged `bootId`. An install that runs past the 2-minute limit gives no such evidence. Word it without that claim, for example "{name} is taking longer than 2 minutes to install v{target}. Check BiBCode on {name}." A rejected install request and an unreadable server before the run keep the claim, because nothing was installed in either case.
9. **`bootId` goes in the descriptors only: confirmed.** Pairing payloads are credentials and must not carry it.
10. **Retry asks for confirmation again.** **Retry**, from the row or the toast, reopens the confirmation dialog with fresh counts. An update stops running agents and terminals, and that work may have restarted since the failure (UI.md: confirm hard-to-undo actions; keep defaults safe). Update Task 13's tests and the Task 12 toast action to match.
11. **Seeded `remote-install` lane: its first real run is in CI.** Confirmed. It stays banned locally.
12. **Rail polling during a run: accepted.** It runs only while busy, at 2.5 s.
13. **WSL wording.** When a remote-initiated install fails protection on a WSL secondary, append "Finish the update on the host." to the host's sentence. Change only `run_remote_install`'s remote path; host-initiated installs keep today's sentence.
