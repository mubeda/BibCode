# Remote server updates: check, download, install and restart from the client

Status: **Approved by the user on 2026-09-24** (the recommended option on every ruling listed below).

Input: `docs/plans/remote-servers/orca-remote-updates-research.md` ("research"). BiBCode lines
refer to `fd5effbb`; re-read the files the batch-1 badge fix is editing (`ConnectTab.tsx`,
`EnvironmentContextCard.tsx`, `ServerUpdateBadge.tsx`, `remoteUpdates.ts`,
`remote_update_delegate.rs`, and its additions to `remote.md` and `overview.md`) before
implementing. `Orca:` paths are relative to `/work/github/orca` at `122b8c25d7`.

## Problem and evidence

- **The user's host cannot be updated remotely.** `Ai-server` runs the desktop AppImage shared
  through **Share this host → Another device**, so it listens on `0.0.0.0:3773`
  (`apps/desktop/src-tauri/src/backend.rs:2769-2796`). The maintenance routes are always
  registered (`apps/server/src/http.rs:151-154`), but `UpdateMaintenance` is built only for a
  loopback or WSL-owned bind (`lifecycle.rs:383-398`, `maintenance.rs:630-642`). The protected
  install behind `updater.install` (`remote_update_delegate.rs:98-140`, `updates.rs:486-742`)
  gets a 404 from `prepare` (`http.rs:419-420`, `tests/production_maintenance.rs:438-458`) and
  aborts (`updates.rs:667-673`), and the delegate cannot skip protection
  (`remote_update_delegate.rs:136-139`). `docs/architecture/remote.md:651-654` documents the
  gap. The fix is required.
- **The client cannot follow or verify the flow.** The wire carries no percent, target, stage
  or per-boot identity (`remote_update_delegate.rs:40-66`,
  `packages/contracts/src/remoteUpdate.ts:33-39`, `environment.ts:68-82`), so slow, failed and
  successful restarts look alike. The card offers only **Check for updates**
  (`sidebar/EnvironmentContextCard.tsx:99-111`); the Settings row's **Update** has no
  confirmation (`remote-servers/ConnectTab.tsx:334-345`).
- **The restart stops running work** (`apps/server/src/production/runtime.rs:598-606`), while
  conversations, queued messages and resume cursors survive
  (`docs/architecture/overview.md:1027-1034`, `docs/architecture/providers.md:119-120`). Each
  AppImage update restart also leaves the old runtime running (decision 5).

## Scope and prerequisites (decided)

- **In scope:** desktop-hosted (`interactive`) servers on Linux AppImage, macOS and Windows.
- **Deferred:** headless self-update (`supervised`, research §5.4). Orca does not self-update a
  Linux `serve` either (`Orca: src/main/serve-update-handoff.ts:22-24`), and it needs a signed
  server feed; server signatures are optional today (`docs/user/server-installation.md:52-56`).
  Headless servers, such as Ai-server's stopped 0.5.4 RPM, stay manual.
- **Host consent: allow and notify.** No prompt on the host, so unattended hosts still update;
  the host shows a notice naming the requesting device and logs the request (decision 4).
- **Prerequisite:** the batch-1 badge fix (in progress): **Checking…**, **Not checked yet**,
  **Can't reach updater** with **Retry**, polling while busy, and no early `installing`.
- **Rollout:** the fix runs on the host, so a wide-bound host at v0.6.2 or older takes its first
  update with this change locally.

## Alternatives and decisions

### 1. Protecting a wide-bound host (recommended: in-process protection)

- **(a) In-process protection for the in-process primary (recommended).** Build
  `UpdateMaintenance` in desktop mode with a bootstrap token whatever the bind, but give it to
  `AppState` only when `maintenance_routes_enabled` holds. HTTP then still answers 404 on a
  wildcard bind (`production_maintenance.rs:419`), keeping the loopback-or-WSL invariant
  (`overview.md:706-709`). `ServerHandle` (`lifecycle.rs:68-78`) exposes the owner. The desktop
  takes it where the primary starts (`backend.rs:1800-1834`), before
  `ManagedBackendRuntime::new` (`:376`) consumes the handle, and carries it on
  `BackendUpdateSnapshot` (`:659-664`), not on `BackendRunConfig` or `BackendUpdateEnvironment`,
  which derive `PartialEq` (`:69`, `:648-649`).
  Protection (`updates.rs:960-1061`) calls it for the primary and keeps HTTP for WSL and other
  external backends, with the same bounds (45 s prepare, 250 ms progress, 10 s commit), error
  text and exit on cancel. No new listener, port or credential; the requester stays connected
  through protection; local installs while sharing are protected again (`remote.md:651-654`
  retires).
- **(b) Narrow to loopback first: rejected.** Narrowing restarts the backend and drops
  connections and running turns (`remote.md:591-593`). The requester goes blind before
  protection, work stops twice, and protection gets tied to the exposure coordinator and the
  firewall rule (`remote.md:527-556`).
- **(c) Loopback-only maintenance listener: rejected.** It adds a second listener per runtime
  (port, readiness, shutdown, discovery) for a caller in the same process.

### 2. Contract changes (additive, decode-defaulted)

No new `RemoteUpdateState` literal: an older client's `Schema.Literals` decode would reject the
snapshot. New string fields decode as plain strings and unknown values get a generic label.
`packages/contracts` stays schema-only; the Rust mirrors live in `apps/server`.

| Where                              | Addition                                                               | Meaning                                                                           |
| ---------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `RemoteUpdateSnapshot`             | `downloadPercent: number \| null`                                      | The desktop's existing percent (`updates.rs:1287`).                               |
|                                    | `targetVersion: string \| null`                                        | The version this install applies (available, then downloaded).                    |
|                                    | `installStage: string \| null`                                         | Stage of the environment being protected (`updates.rs:59-66`), then `installing`. |
| `RemoteUpdateSupport`              | `installKind: string`, default `"unknown"`                             | Headless: `archive`, `system-package` or `unknown` (`static_assets.rs:52-72`).    |
| `ExecutionEnvironmentDescriptor`   | `bootId: string \| null`                                               | Random for each `ServerRuntime` start.                                            |
| `ExecutionEnvironmentCapabilities` | `remoteUpdateProgress: boolean`, default `false`                       | Advertises everything in this table.                                              |
| New read method                    | `updater.activeWork` → `{runningTurns, liveTerminals, queuedMessages}` | Counts across all clients; scope `orchestration:read`.                            |
| `DesktopUpdateState` (`ipc.ts`)    | `requestedBy: {label, detail} \| null`                                 | The host notice (decision 4).                                                     |

- `bootId` and the `remoteUpdateProgress` capability come from every descriptor producer
  (`http.rs:339-379`, `production/control.rs:2149-2169`, `lifecycle.rs:46-66`); `bootId` also
  goes wherever `storageInstanceId` is published. It is never persisted and never gates
  storage identity (`docs/architecture/connection-runtime.md:513-532`).
- `activeWork` is its own read method: status is polled every second and prepare holds the
  store lock (`overview.md:716-719`), so a count on each poll could stall. The client marks
  SSH-launched servers from their `SshConnectionTarget`. `request_install` takes a requester
  (decision 4), changing the production delegate and `FixtureDelegate`
  (`remote_update.rs:217-242`).
- Wire: `rpc.ts` gains `updater.activeWork`, a read in `rpc/methods.rs:164-166` and
  `auth/scope.rs:57`. `vp run check:contracts` regenerates `fixtures/rpc-wire/manifest.json`
  and adds `typed-failures/updater__activeWork-0*.json`. Adding `bootId` to the exporter's
  `fixtureServerConfig` regenerates `stream-shapes/subscribeServerConfig-0*.json` and
  `subscribeServerLifecycle-0*.json`. A new `contract-shapes/updater__status-success.json`
  round-trips the snapshot fields through Rust; none exists today.

### 3. Client coordinator (`packages/client-runtime`)

A port of Orca's coordinator, restart wait and failure probe
(`Orca: src/renderer/src/runtime/remote-server-update-coordinator.ts:188-296`,
`remote-server-restart-wait.ts:33-81`, `remote-server-install-failure-probe.ts:20-36`) into
`packages/client-runtime/src/state/remoteUpdates.ts`, shared by browser and desktop.

- **Lifetime.** One single-flight run per environment in an Atom family, owned by the Atom
  runtime, so closing the dialog does not cancel it. At most two run at once
  (`MAX_CONCURRENT_REMOTE_UPDATE_CHECKS`, `remoteUpdates.ts:14`); a third shows **Queued**.
  While a run is active, the card and row render its state, so batch-1's status query is not
  observed and does not poll alongside it.
- **No effect spans the restart.** Disconnect interrupts environment work
  (`connection-runtime.md:343-347`), so the run follows `EnvironmentRegistry.stateChanges`
  (`connection/registry.ts:114`). For each connected generation it calls `server.getConfig`
  (`bootId`, `serverVersion`) and `updater.status`, each capped at 10 s and the budget left.
- **Steps.** Record `bootIdBefore`, call `updater.install` (30 s, `remote_update.rs:79`), then
  poll status every second: `downloading` shows the percent (10 min, Orca's
  `coordinator.ts:70-74`); `installing` shows the stage (2 min: 30 s drain `config.rs:95`, 45 s
  prepare, 10 s commit); `up-to-date` ends as **Already up to date**. After the disconnect the
  restart budget is 3 min, with a supervisor retry at most every 5 s (`registry.ts:102`).
  **Success** needs `bootId ≠ bootIdBefore` **and** `serverVersion ≥ targetVersion` on a
  connected generation; without `remoteUpdateProgress`, the version alone, with no counts or
  stages.
- **Failure probe, adapted.** Orca probes only while the same runtime answers
  (`remote-server-install-failure-probe.ts:27-33`), because a failed Electron install keeps its
  process. A failed BiBCode protection restarts the prior backends in the same desktop process
  (`overview.md:742-749`), so the client returns to a new boot on the old version. Every
  connected generation that is not a success therefore reads `updater.status`, and `error` ends
  the run with its text. That text belongs to this attempt: the host clears it when protection
  starts (`updates.rs:597-601`) and keeps a failure for the life of the process (`:768-792`). A
  new boot on an older version with no error fails as "restarted on v{old}".

### 4. Host notice

- **Seam.** `updater.install` moves to `register_unary_with_context`
  (`apps/server/src/rpc/session.rs:403-417`), looks up the caller's `ClientMetadata` (label,
  OS, address; `auth/model.rs:175-187`) through `AuthService::list_clients`
  (`auth/service.rs:1709-1723`) and passes it to `request_install`. A remote request reaches
  the host through the server→host delegate seam (`remote-servers-spec.md:309-315`), never
  `DesktopBridge`. The desktop keeps it as `requestedBy`, which the host window receives on the
  existing `desktop:update-state` event (`updates.rs:21`).
- **Toast on the host**, once per install (a client joining a running install adds none):
  **Update requested from another device**, "BiBCode Desktop on MacIntel (192.168.1.34) is
  installing v0.6.4. BiBCode restarts when it's done.", and **Manage devices**, which opens
  Share this host, where the device can be revoked. The label is generic today
  (`apps/web/src/connection/platform.ts:178-186`), so OS and address identify the device.
- **Operational log:** one `tracing::info!` line in `server.log`
  (`docs/operations/observability.md:21-24`) with label, OS, address, a short session-id prefix
  and the versions, plus a `warn` line on failure. No credentials.

### 5. The AppImage restart leaves the old runtime running (fix)

- **Observed on Ai-server** (read-only `ps`, `/proc/mounts`, fd links, and `fdinfo` flags for
  pipe directions). Runtime 16492, started 2026-09-23 10:14, still holds `/dev/fuse`, the write
  end of `pipe:[128728]` and the deleted `~/.cache/tauri_current_app*/current_app.AppImage`
  (about 100 MB). The read end is held by the current runtime 392680, `bibcode-desktop` 392675
  and its WebKit children, not by its terminal or provider children. 392680 also holds fd 1023
  on the old mount, which no fresh launch has.
- **Mechanism.** The updater moves the running AppImage aside and writes the new one
  (`tauri-plugin-updater-2.11.0/src/updater.rs:1047-1118`). `app.restart()` (`updates.rs:732`)
  ends in `Command::new(appimage).spawn()` and `exit(0)` (`tauri-2.11.5/src/process.rs:74-89`),
  so the child inherits every descriptor without close-on-exec, including the runtime's
  keep-alive pipe. The old FUSE daemon lives until the last holder of that pipe exits (type-2
  runtime behavior, consistent with the observation). Each update restart thus adds a stale
  mount, a 15 MB daemon and a pinned old AppImage until BiBCode quits.
- **Fix.** On Linux, right before `app.restart()`, mark every descriptor above 2 close-on-exec
  with `close_range(3, ~0U, CLOSE_RANGE_CLOEXEC)`, falling back to a `/proc/self/fd` loop (the
  repo sets the flag per descriptor in `third_party/portable-pty/src/unix.rs:316-331`). Only
  exec'd children are affected, the process is exiting, and Tauri relaunches later from its
  event loop (`tauri-2.11.5/src/app.rs:588-611`).
- **Residuals.** The relaunched app still inherits the old environment; stale `.mount_*`
  entries sit behind the new mount's own, and children are already scrubbed
  (`overview.md:316-324`). Ai-server's leftover goes away when BiBCode quits there; nothing
  touches it now.

## UI

- **Action.** The card and the Settings row show **Update to v{latest}…** for an `interactive`
  host in `update-available`.
- **Confirmation** (`UI.md:130`), with counts from `updater.activeWork`: "Updating Ai-server
  restarts BiBCode there. 2 running agents and 3 terminals will stop. Conversations and queued
  messages are kept, and agents continue when you send the next message." Variants: "Nothing is
  running on it now."; "Running agents and terminals on it will stop." (no counts); "This page
  reloads when Ai-server is back."; "v0.6.4 is newer than this app (v0.6.3). Update this app
  too." Buttons: **Update Ai-server** and **Cancel**. Always confirm: the restart also closes
  BiBCode for anyone at the host, which no count shows.
- **Progress** replaces the action on the badge and the row: **Downloading 42%**, **Backing up
  project data…** (from `installStage`), **Restarting…**, **Checking the new version…**, then
  **Updated to v0.6.4** with a toast.
- **Failures** (`UI.md:178-184`), as a toast and in the row, with **Retry**: "Couldn't update
  Ai-server: {host message}. Nothing was installed; it runs v0.6.2 again."; "Ai-server hasn't
  come back after the update. Check BiBCode on Ai-server; it may be on a different port.";
  "Ai-server restarted on v0.6.2 instead of v0.6.4."
- **Browser mode.** When the page's own server reconnects with a new `bootId` and a
  `serverVersion` other than the bundle's (`apps/web/src/versionSkew.ts:26-44`), a lasting
  prompt says "BiBCode on this server was updated to v0.6.4. Reload to use it." with
  **Reload**. It never reloads by itself, so unsent text survives.
- **Manual hosts.** **Show update steps** replaces the card's **Check for updates**, which does
  nothing there (`remote_update.rs:142-148,179-185`). Steps follow `installKind` and the host's
  OS and architecture instead of the generic text (`settings/ServerUpdateBadge.tsx:69-79`):
  archive (download, check `bibcode-server-SHA256SUMS`, replace, restart); system package
  (`sudo apt install ./….deb` or `sudo dnf install ./….rpm`, restart); SSH-launched (replace
  the binary, stop the old server so the next connection relaunches it); otherwise generic.
  Each has **Copy**.

## Risks

- **Running work stops.** The counts, the durable queue and resume on the next message
  mitigate it; nothing installs by itself. "Update when idle" stays deferred.
- **Updating the host you use.** Browser page: the reload prompt. Host user: the notice. Connect
  relay: its endpoint is quiesced (`runtime.rs:604`) and registers again within the budget.
- **Finding a wide-bound host again.** The client keeps its saved endpoint. The old process
  stops its backend before installing (`updates.rs:700`), and each launch scans from 3773 for a
  port free on loopback and both wildcards (`backend.rs:551-558,2811-2818`), so the port
  normally stays. The replacement starts loopback-only (`backend.rs:1098`) until the host
  window's reconciler sees the live **Another device** grant and widens it
  (`apps/web/src/AppRoot.tsx:154`, `remote.md:527-534`): one more restart and `bootId`, and the
  client reaches only the wide boot. If the port moved, the endpoint is stale and the run fails
  with the "different port" message (ruling R3).
- **Version skew.** The feed's latest can be newer than the client. The compatibility verdict
  is re-evaluated on reconnect (`connection-runtime.md:538-554`), and the confirmation warns.
- **Servers behind the client.** Decided: do not adopt Orca's rule that such a server is never
  current (`Orca: remote-server-update-coordinator.ts:121-139`). BiBCode cannot install a
  chosen version, so "Update available" for a version the feed lacks would be false; the
  version-drift line (`ConnectTab.tsx:288-293`) shows the gap (ruling R4).
- **Windows hosts.** The passive NSIS installer relaunches the app
  (`tauri.release.conf.json:10-12`). A WSL secondary that fails protection cannot be excluded
  remotely (`updates.rs:93-117`), so the error says to finish on the host.

## Validation

- **Server:** on a `0.0.0.0` desktop bind the in-process handle prepares, backs up and commits
  while HTTP `prepare` still answers 404 (extend `tests/production_maintenance.rs`). `bootId`
  changes per start and is on every descriptor; `updater.activeWork` counts two sessions' work;
  install passes the caller's metadata and logs once; new fields serialize
  (`tests/remote_update_rpc.rs`).
- **Desktop:** the primary uses the in-process transport and an external backend HTTP, with the
  same failure text; the delegate maps percent, stage and target; `requestedBy` is set and
  cleared; on Linux an inherited pipe gets close-on-exec and a spawned child lacks it.
- **Client runtime** (fake registry and RPC): success; error from the old boot; new boot on the
  old version, with and without an error; restart timeout; bounded reconnect calls;
  `up-to-date`; two runs and a queued third; unmount does not cancel; no capability.
- **Web:** confirmation variants, progress and failure labels, the reload prompt in browser
  mode only, **Show update steps** per `installKind`; reviews against
  `vercel-react-best-practices` and `UI.md`. **Contracts:** older payloads decode with
  defaults, and `vp run check:contracts` passes.
- **Live test.** Add a `remote-install` lane to `scripts/seeded-desktop-upgrade-smoke.ts`,
  which already builds a candidate and a current-source baseline with an overlay identifier, an
  ephemeral updater key and a loopback mock feed (`:222-255,1389-1627`). The baseline host (fix
  included, lower version) runs under WebDriver with its own `BIBCODE_HOME` and `BIBCODE_PORT`.
  An **Another device** offer minted through the desktop bridge widens it to `0.0.0.0` (checked
  with `ss -ltn`). A Node client-runtime driver pairs over loopback (the server's bind sets the
  gate), reads `updater.activeWork` and runs the coordinator. Assert percent and stages, the
  disconnect, a new `bootId` on the candidate version, the same `storageInstanceId`, a verified
  `PreUpdate` backup, the requester line in `server.log`, and one FUSE mount and runtime after.
- **Where it runs.** In CI (`desktop-upgrade-smoke.yml`, already under `xvfb-run`). On Ai-server
  only in isolation: the harness cleans up with `pkill -TERM -x bibcode-desktop`
  (`seeded-desktop-upgrade-smoke.ts:832-846`), which would kill the user's app, so scope it by
  cgroup (`systemd-run --user --scope`) or by `BIBCODE_HOME` in `/proc/<pid>/environ`. Follow
  the runbook's Xvfb and XDG isolation (`docs/testing/linux-desktop.md:258-277`), since
  deep-link registration writes the `bibcode://` handler (`overview.md:359-365`). Avoid ports
  3773, 5733, 13773, 18431 and 18432, and use an AppImage name whose `.mount_` prefix is not
  `bibcod`.
- **Not verified live:** the production feed and key, the Mac app as requester (web tests cover
  its UI), and a real LAN hop. If the widen step cannot run, that leg rests on the server test
  with a real `0.0.0.0` bind plus the desktop transport test, and the report says so. Windows
  and macOS hosts get the same lane.

## Living documentation to update

- `docs/architecture/remote.md` "Remote server updates" (fields, `updater.activeWork`,
  coordinator, notice, `installKind`, reload prompt), dropping `:651-654`;
  `docs/architecture/overview.md` "Desktop update protection" (in-process transport; the HTTP
  invariant at `:706-709` is unchanged), "Remote server updates" (`:754-785`) and the relaunch
  descriptor rule.
- `docs/architecture/connection-runtime.md`: `bootId` in "Data boundary" and retry requests in
  "State and retry policy". `docs/user/remote-access.md`: an "Update a remote server" section.
- Runbooks: "Remote server updates" in `docs/testing/{linux,macos,windows}-desktop.md`, a
  stale-runtime check in the Linux AppImage section, and the seeded matrix in
  `docs/operations/release.md:237-275` and `docs/operations/ci.md:64-65`.

## Rulings requested from the user

- **R1.** Wide-bind fix: option (a), in-process protection (recommended).
- **R2.** Host notice as specified; confirm the device wording (label, OS and address).
- **R3.** Sticky port: try the primary's last bound port, when it is free on all probe hosts,
  before scanning from 3773. Saved endpoints then survive update restarts and reboots, for one
  persisted desktop setting. Recommended as a small separate change.
- **R4.** Servers behind the client: keep the host feed as the source of truth (recommended).
- **R5.** Ship the AppImage relaunch fix (decision 5) with this work (recommended).
