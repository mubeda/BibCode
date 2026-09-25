# Remote server updates: Orca vs BiBCode, and what BiBCode should add

Research into how Orca lets a client check, download, and install updates on a paired
remote server, compared with what BiBCode ships today. It closes with a gap analysis and a
recommended design direction.

- **Orca:** `/work/github/orca` at `122b8c25d7` (package version `1.4.197`, committed
  2026-09-24). Paths prefixed `Orca:` are relative to that root.
- **BiBCode:** worktree `main-3`, read as `3d4bc210` (v0.6.2) **plus uncommitted
  changes**. Those changes were committed while this research ran (`4becbdf2`, `3a57c49c`,
  `fd5effbb`). Spot checks confirmed the cited lines are unchanged at `fd5effbb`, so line
  numbers refer to that commit. Paths prefixed `BiBCode:` are relative to the repository
  root.
- **Tauri updater:** `tauri-plugin-updater` 2.11.0 (`BiBCode: Cargo.lock:5794-5795`),
  read from the local cargo registry.
- **Method:** source, tests and first-party docs only. The CodeGraph MCP server failed to
  connect, and `codegraph sync` was not run because this task was read-only, so the
  findings come from `rg` and direct reads.
- **Date:** 2026-09-24.

The earlier port study is `orca-remote-servers-research.md` (Orca v1.4.178-rc.2; the
actual port baseline is Orca `main` at `026389a3bc`, 2026-08-27). Its §4 covered the update
surface only briefly. Orca's client-side update coordinator, restart-wait with failure
probing, update dialog and status-bar segment were already in that baseline (Orca
`0326594d52`, 2026-07-22; see `orca-fixes-since-port-research.md`), so BiBCode's port
simply did not carry them over.

> Naming note: `docs/plans/2026-07-27-remote-update-version-{design,plan}.md` concern the
> **About screen** label `Version 0.2.14 → 0.2.15` for the local desktop updater's
> available version (`design.md:5-17`). They are unrelated to remote servers.

## Summary

- **The host checks its own feed; the client only asks.** In Orca, a paired client calls
  `updater.getStatus`, `updater.check`, `updater.download` and `updater.install` over the
  normal runtime RPC. The host's own electron-updater does the checking, downloading and
  installing, from the generic GitHub feed (`Orca: src/main/runtime/rpc/methods/updater.ts:10-31`,
  `src/main/updater/updater-setup.ts:159-164`). BiBCode works the same way for desktop-hosted
  servers: the host's Tauri updater reads GitHub `latest.json`. A headless `bibcode serve`
  has no feed at all (`BiBCode: docs/architecture/remote.md:485-490`).
- **Orca's client runs the whole update from one button.** Its coordinator does check,
  then poll, then download (with a percent), then install, then waits for the replacement
  process. The wait succeeds only when a _new_ `runtimeId` answers on the target version,
  within a 3-minute budget. While waiting, it reads the _old_ process's updater error so a
  failed restart is reported by its cause. It runs at most 2 servers at a time. The
  client's own version decides eligibility (a server behind the client is "available") and
  the release channel, but the version actually installed is whatever the host's feed
  offers (`Orca: src/renderer/src/runtime/remote-server-update-coordinator.ts:64-74,99-296`,
  `remote-server-restart-wait.ts:33-81`).
- **Orca's UI shows the update as it happens.** It offers "Check for Server Updates" in
  General settings and in the Remote Servers pane, per-row "Orca vX" plus a status badge and
  an "Update" button, and a dialog with progress bars. The dialog warns about the restart
  using live tab and pane counts and offers "Update all N servers". The status bar shows
  "Updating x/y" (`Orca: src/renderer/src/components/settings/RemoteServerUpdateDialog.tsx:108-250`,
  `components/status-bar/RemoteServerUpdateStatusSegment.tsx:7-97`).
- **Orca's host installs a remote request exactly like a local one.** There is no prompt on
  the host. The host gets 2.5 s of pre-quit cleanup, then the native quit-and-install, and
  only in-process PTYs are killed. Daemon-owned PTYs survive, and the daemon is the default
  terminal provider in both desktop and `serve` modes
  (`Orca: src/main/updater/updater-install-execution.ts:73-127`, `src/main/ipc/pty/kill-all.ts:4-11`,
  `src/main/startup/main-process-pty-startup.ts:125-132`).
- **Orca installs remotely only where the install is safely restartable.** That covers a
  desktop app on macOS or Windows, a Linux AppImage, and a macOS app-bundle `orca serve`
  running under the CLI supervisor. Linux `.deb`/`.rpm`, Linux headless `serve` and `orcad`
  report "manual" (`Orca: src/main/updater/updater-remote-status.ts:20-49`,
  `src/main/serve-update-handoff.ts:22-24`). An SSH-driven `orcad` deploy with an activation
  record, a pre-activation snapshot and rollback exists as library code only: no production
  entry point calls `deployOrcad` or `rollbackOrcad` at `122b8c25`.
- **BiBCode ships the check and a single-shot install for desktop-hosted servers.**
  `updater.status`, `updater.check` and `updater.install` exist. `interactive` mode (a
  desktop-hosted in-process server) runs check, download and a _protected_ install inside
  one request. `manual` mode covers headless and WSL servers. `supervised` is reserved in the
  schema (`BiBCode: packages/contracts/src/remoteUpdate.ts:5-53`,
  `apps/desktop/src-tauri/src/remote_update_delegate.rs:98-140`). The Settings row has an
  **Update** button (`ConnectTab.tsx:339-345`). The sidebar context card from the screenshot
  offers only **Check for updates** (`EnvironmentContextCard.tsx:99-111`).
- **What BiBCode lacks compared with Orca:**
  - download progress on the wire;
  - a restart warning with real counts;
  - a confirmation step;
  - a restart-wait that proves the new version answered;
  - a per-boot server identity;
  - a status that refreshes during the flow;
  - any headless self-update path;
  - manual instructions tailored to how the server was installed.
- **Main structural gap (inferred from code and tests, not tried live).** A desktop host
  shared through **Share this host → Another device** binds to `0.0.0.0`. On such a bind
  the server never builds the desktop-only maintenance owner, so the always-registered
  maintenance routes answer update protection's `prepare` call with a 404 and the primary
  backend fails protection. The remote delegate always
  passes `DesktopUpdateInstallInput::default()`, so it can never take the local user's
  "skip protection after a failure" path. The shipped remote install therefore works only
  when the host keeps a loopback bind, for example behind an SSH tunnel or the Connect
  relay (§2.4).
- **"Status unavailable" in the screenshot is a state-model conflation, not a transport
  failure.** The badge uses one label for three things:
  - no snapshot yet;
  - a failed status query;
  - an `interactive` host whose updater has never completed a check.

  A desktop host starts in that last state after every launch, including right after an
  update, and stays there until its first background check 15 s later. The card never
  re-queries while it stays mounted, so the label sticks. "Up to date" after **Check for
  updates** proves `Ai-server` is a desktop-hosted (interactive) server. A headless server
  can only ever show **Manual updates** (§3).

- **Recommendation (details in §5).**
  - First, fix the badge semantics and wire the card to the existing install path.
  - Next, add decode-defaulted `downloadPercent` and install-stage fields, plus a
    descriptor `bootId`.
  - Then port Orca's restart-wait and failure probe into `packages/client-runtime`, behind
    a confirmation that counts the running agents and terminals.
  - The wide-bind protection fix and a headless `supervised` mode both change documented
    boundaries. They need approved designs before implementation.

---

## 1. Orca: the remote server update flow

### 1.1 Topology: who checks what

The client never talks to the release feed. It calls four runtime RPC methods, and the
**host** delegates them to its own updater:

- `updater.getStatus`, `updater.check`, `updater.download` and `updater.install` are
  registered in `Orca: src/main/runtime/rpc/methods/updater.ts:10-31`.
- They call a replaceable adapter. Its default refuses everything with
  `remote_update_manual_required` and reports `unsupported-headless-serve` /
  `updater-unavailable` (`src/main/runtime/remote-server-updater.ts:7-36`).
- Main-process preflight swaps in the real updater before Electron is ready
  (`src/main/startup/main-process-preflight.ts:145-150`). One `UpdaterSetup` instance
  shares state between local and remote callers (`src/main/updater.ts:17-18`).
- The host's electron-updater keeps `autoDownload = false`. It uses the generic feed
  `https://github.com/stablyai/orca/releases/latest/download`, checks once per day, and
  re-checks on resume or focus when that interval has elapsed
  (`src/main/updater/updater-setup.ts:143-164,223-253`, `updater-state.ts:8`).

### 1.2 Contract

`Orca: src/shared/remote-server-update.ts:3-32`:

```ts
REMOTE_SERVER_UPDATE_CAPABILITY = "updater.remote-control.v1";
RemoteServerUpdateSupport = {
  installMode: "interactive" | "supervised-headless-serve" | "unsupported-headless-serve",
  automatic: boolean,
  reason:
    "available" | "manual-service-update-required" | "unpackaged-build" | "updater-unavailable",
};
RemoteServerUpdaterSnapshot = { appVersion, runtimeId, support, status: UpdateStatus };
RemoteServerUpdateInstallResult = { accepted: true, fromVersion, targetVersion, runtimeId };
```

`UpdateStatus` (`src/shared/update-status-types.ts:59-95`) takes these states:

| `state`         | Fields                                                                    |
| --------------- | ------------------------------------------------------------------------- |
| `idle`          | none                                                                      |
| `checking`      | none                                                                      |
| `available`     | `version`, `changelog`, `externallyManaged?`                              |
| `not-available` | none                                                                      |
| `downloading`   | `percent`, `version`                                                      |
| `downloaded`    | `version`                                                                 |
| `error`         | `message`, `version?`, `retryable?`, `recovery?` (Linux package recovery) |

Other contract points:

- **Capability and version always visible.** Every host advertises the capability
  (`src/shared/protocol-version.ts:357`), and `status.get` embeds `appVersion` and
  `remoteUpdateSupport` (`src/main/runtime/rpc/methods/status.ts:12-18`). A client
  therefore knows whether remote install is possible before it asks.
- **Live-work counts.** `RuntimeStatus` also carries `liveTabCount` and `liveLeafCount`
  (`src/shared/runtime-session-contracts.ts:72-73`, filled by
  `src/main/runtime/orca-runtime-get-status.ts:127-128`). The client uses them for the
  restart warning.

### 1.3 Host-side rules (check → download → install)

`Orca: src/main/updater/updater-remote-status.ts`:

- **`automatic`** is true only when all of these hold (`:20-49`):
  - the build is packaged;
  - the updater is initialized;
  - the Linux package marker is neither `deb`, `rpm` nor `unusable`;
  - the install mode is not `unsupported-headless-serve`.

  Every other case returns `manual-service-update-required`, `unpackaged-build` or
  `updater-unavailable`.

- **`check`** asserts `automatic`, then runs the same "check from menu" path as a local
  user and returns a snapshot (`:66-73`).
- **`download`** requires `state === "available"`. Otherwise it fails with
  `remote_update_not_available` (`:75-82`).
- **`install`** requires `state === "downloaded"`. Otherwise it fails with
  `remote_update_not_downloaded` (`:84-98`). It returns
  `{accepted, fromVersion, targetVersion, runtimeId}` and then calls `quitAndInstall`.
- **The install mode** is `interactive` for the GUI. For `serve` it is
  `supervised-headless-serve` only when a supervisor handoff path is configured, and
  `unsupported-headless-serve` otherwise (`:100-105`).

The rest of the host-side path:

- **The RPC reply goes out before the app quits.** `quitAndInstall` defers the real quit
  by `QUIT_AND_INSTALL_DELAY_MS = 100` ms
  (`src/main/updater/updater-download-install.ts:34-37`, `updater-state.ts:14`).
- **Download acceptance is visible at once.** Download sends `downloading 0%` immediately.
  It refuses a Linux install that a package manager owns (externally managed)
  (`updater-download-install.ts:62-78,86`).

### 1.4 Client coordinator (renderer)

The store slice drives the flow (`Orca: src/renderer/src/store/slices/remote-server-updates.ts`):

- **Transport.** It calls the main-process
  `runtimeEnvironments.call({selector, method, params, timeoutMs})` with a 15 s default per
  call (`:20-49`).
- **Refresh** lists the saved environments and marks each one `checking`. It reads the
  client's own version, then inspects every server (`:82-133`).
- **Start** queues the eligible entries (`available` or `failed`) and runs them with
  `MAX_CONCURRENT_REMOTE_SERVER_UPDATES = 2` (`:18,135-178`,
  `runtime/remote-server-update-batch.ts:3-21`).

Client phases (`runtime/remote-server-update-coordinator.ts:21-32`): `checking`,
`available`, `current`, `manual`, `offline`, `queued`, `checking-update`, `downloading`,
`restarting`, `updated`, `failed`.

**Inspect** (`:99-186`):

- If `status.get` fails, the server is `offline`.
- If the host lacks the capability or `automatic`, the server is `manual`, unless its
  version already matches the client's, which makes it `current`.
- Otherwise, a server older than the **client's version** is `available`, with
  `targetVersion = clientVersion` as a provisional display value. Run replaces it with the
  version the feed offers.
- With explicit check options (a modifier-click selects the prerelease channel), it calls
  `updater.check` and polls until the state is `available` or `not-available`.

**Run** (`:188-296`):

1. `checking-update`: call `updater.check`, with the prerelease channel inferred from the
   target version (`:203-209`). Poll `updater.getStatus` until the state is `available` or
   `not-available`.
   - If the result is `not-available` and the server still has not reached the client's
     version, it fails with `remote_update_requested_version_unavailable` (`:218-232`).
2. `downloading`: set `targetVersion` to `available.status.version`, the **host feed's**
   offer. Call `updater.download`, then poll every 500 ms until `downloaded`, copying
   `status.percent` into the entry on each poll (`:237-259`).
3. `restarting`: call `updater.install`, whose result supplies the final `targetVersion`,
   then `waitForReplacementRuntime` against that target (`:261-275`).
4. `updated`, with the replacement's version and runtime id. Any throw produces `failed`
   with a mapped message (`:276-294`).

Timing and polling rules:

- **Budgets:** 10 minutes per updater operation, 3 minutes to reconnect, 500 ms poll
  interval (`:70-74`).
- **Polling helper:** throws on any `error` snapshot. When the budget runs out it throws
  `remote_update_updater_timeout` (`runtime/remote-server-updater-polling.ts:14-35`).
- **Restart wait** (`runtime/remote-server-restart-wait.ts:33-81`):
  - It polls `status.get`, capping each call at the remaining budget.
  - It returns only when `runtimeId` differs from the install result's and the version has
    reached the target (`:51-53`). `runtimeId` is a per-process `randomUUID()`
    (`src/main/runtime/orca-runtime-runtime-id.ts:57`), so a same-process answer never
    counts as a restart.
  - From the second tick on, if the **same** runtime still answers, it reads
    `updater.getStatus` and throws that process's install-failure text
    (`remote-server-install-failure-probe.ts:14-36`). Without this, "could not restart"
    would look like a slow restart until the 3-minute timeout.
- **Error copy:** codes map to user copy, for example "The server did not reconnect on the
  updated version." (`runtime/remote-server-update-errors.ts:3-54`).

### 1.5 UI presentation

- **Entry points:**
  - Settings → General: a "Remote Orca Servers" block with **Check for Server Updates** and
    a summary line: "N paired servers · N ready to update · N up to date · N manual ·
    N offline" (`components/settings/GeneralRemoteServerUpdates.tsx:10-137`, mounted from
    `GeneralUpdateSettingsSection.tsx:253`).
  - The Remote Servers "Connect" section has the same button, next to **Add Server**
    (`components/settings/runtime-servers-connect-section.tsx:93-119`).
- **Server rows** show "Orca v{version}" (or "Orca version unavailable") and a compact
  badge. Manual rows add help text and failed rows add the error. Rows in `available` or
  `failed` get an **Update** button that opens the dialog
  (`components/settings/runtime-server-row.tsx:143-180`).
- **Badge labels:** Checking…, Update available, Up to date, Manual update, Offline, Queued,
  Checking update…, Downloading… NN%, Restarting…, Updated, Update failed. Each has an icon
  (`RemoteServerUpdateStatus.tsx:10-93`).
- **Manual help copy:** "Update Orca on the server host — through its system package
  manager if it was installed from a .deb or .rpm, otherwise through the service manager
  that starts it." Separate copy covers dev builds and legacy servers (`:95-112`).
- **The dialog** is lazily mounted at the app root (`app-shell/AppRootSurfaces.tsx:68-69,384`)
  (`RemoteServerUpdateDialog.tsx:108-250`):
  - It re-checks when opened.
  - Each row has **Update this server** or **Retry**, a version line (`current → target`),
    a progress bar while downloading, and the help text "Waiting for the replacement server
    to reconnect on the new version." while restarting.
  - When eligible servers have live work it shows: "Updating restarts these servers.
    {N live tabs} and {M live panes} may briefly disconnect."
  - It confirms "All servers are up to date." when there is nothing to do, and offers
    **Update all {n} servers** when more than one server is eligible.
- **Status bar:** "Updating {done}/{cohort}", "N server updates failed" or "N servers
  updated". Each opens the dialog (`components/status-bar/RemoteServerUpdateStatusSegment.tsx:7-97`,
  `StatusBarSurface.tsx:248`).

### 1.6 Running sessions, terminals and agents during install

- **No host-side confirmation or consent.** A remote `updater.install` goes straight to
  `quitAndInstall` (`updater-remote-status.ts:84-98`). The only warning is the client
  dialog's live tab and pane count (§1.5).
- **Drain is short and best-effort.** Pre-quit cleanup preserves agent auth and flushes the
  store. It is capped at `PRE_QUIT_CLEANUP_TIMEOUT_MS = 2_500` and continues on timeout
  (`updater-install-support.ts:135-173`, `updater-state.ts:15`,
  `src/main/window/main-window-updater.ts:46-73`,
  `src/main/startup/main-window-core-services.ts:129-131`).
- **PTYs.**
  - After the native `quitAndInstall` is invoked, `killAllPty()` runs
    (`updater-install-execution.ts:107-127`). It kills **in-process** local PTYs only:
    "Daemon-backed PTYs are preserved by daemon disconnect" (`src/main/ipc/pty/kill-all.ts:4-11`).
  - The daemon PTY provider is adopted by "both desktop and headless serve"
    (`src/main/startup/main-process-pty-startup.ts:125-132`). Terminals, and the agent TUIs
    inside them, therefore outlive a desktop update.
  - Headless systemd hosts survive only when the daemon got its own
    `orca-daemon-*.scope`. Otherwise a service stop or restart "ends live terminals and
    agent processes" (`docs/reference/headless-linux-server.md:239-261`).
- **Exit is guaranteed.** Once the install is committed, a 20 s exit watchdog forces the
  process out so the installer is never stranded
  (`src/main/update-install-exit-watchdog.ts:4-8,23-38`, armed at
  `updater-install-execution.ts:137-144`).

### 1.7 Restart and reconnect

- **Clients need no re-pairing.** Credentials (the device registry) and state live in
  userData, not next to the binary, so clients reconnect after an upgrade without
  re-pairing (`docs/reference/headless-linux-server.md:452-457`).
- **Replacement detection** uses the `runtimeId` change plus the version check in §1.4.
- **Compatibility is re-evaluated.** A reconnect to a different `runtimeId` drops the cached
  positive compatibility verdict (`src/renderer/src/runtime/runtime-rpc-client.ts:191-211`).
- **Supervised macOS `serve` (§1.9)** has its own verification. The CLI parent waits for
  the new bundle version, respawns the child, and requires an `orca:serve-ready` message
  carrying the target version within `SERVE_REPLACEMENT_READY_TIMEOUT_MS = 60_000`.
  Otherwise it records a failed handoff (`src/cli/runtime/serve-update-supervisor.ts:16,53-108,166-191,216-222`).

### 1.8 Version and protocol compatibility

- **The client's app version gates eligibility; it does not pick the target.**
  - A server counts as outdated when `compareAppVersions(server, client) < 0`
    (`remote-server-update-coordinator.ts:118-139,180-185`), so Orca never calls a server
    "current" while it lags the client.
  - The prerelease channel is inferred from the client's version (`:203-209`).
  - The installed version is whatever the host's feed offers (`:237-242,261-267`). It can
    be newer than the client.
  - If the feed offers nothing and the server has not reached the client's version, the
    run fails with `remote_update_requested_version_unavailable` (`:218-223`).
- **Protocol window.** Wire compatibility is a separate window:
  `RUNTIME_PROTOCOL_VERSION = 3`, with the minimum compatible client and server both at 2.
  The rules say "Exact app-version equality is never required"
  (`src/shared/protocol-version.ts:20-36`).

### 1.9 Platform matrix

| Host                                  | Remote install                     | Mechanism / evidence                                                                                                                                                                                                                                                                            |
| ------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop macOS                         | automatic                          | Squirrel. Quit is deferred until the installer is ready, bounded at 15 s (`src/main/updater-mac-install.ts:5,64-75`).                                                                                                                                                                           |
| Desktop Windows                       | automatic                          | electron-updater with the built-in Authenticode check. "never re-add a verifyUpdateCodeSignature override" (`updater-setup.ts:158`).                                                                                                                                                            |
| Desktop Linux AppImage                | automatic                          | Package marker `AppImage` resolves to `non-root` (`src/main/linux-update-package-type.ts:66-99`).                                                                                                                                                                                               |
| Desktop Linux deb/rpm                 | **manual**                         | `manual-service-update-required` (`updater-remote-status.ts:35-47`). A local install is refused and the renderer is released (`updater-install-execution.ts:29-53`).                                                                                                                            |
| `orca serve`, macOS app bundle        | automatic (supervised)             | The CLI parent sets `ORCA_SERVE_UPDATE_HANDOFF_PATH` only for a mac bundle (`src/cli/runtime/launch.ts:119-126`). The child writes `{phase:"install-requested", fromVersion, targetVersion, servingPid}` (`src/main/serve-update-handoff.ts:22-38`, `src/shared/serve-update-handoff.ts:3-35`). |
| `orca serve`, Linux (AppImage or pkg) | **manual**                         | `hasServeUpdateSupervisor()` requires `darwin` (`serve-update-handoff.ts:22-24`). Download and install are deferred with an error (`updater-install-support.ts:47-68`).                                                                                                                         |
| `orcad` (plain Node)                  | manual                             | The default adapter throws `remote_update_manual_required` (`remote-server-updater.ts:14-36`).                                                                                                                                                                                                  |
| SSH-deployed `orcad`                  | library only, no production caller | See the note below this table.                                                                                                                                                                                                                                                                  |

Notes on the matrix:

- **SSH-deployed `orcad`.** The code is in `src/main/ssh/orcad-remote-deploy.ts:1-14,257-347`
  and `orcad-update-plan.ts`. `deployOrcad` and `rollbackOrcad` appear only in their tests
  (verified with `rg "deployOrcad\b|rollbackOrcad\b"` on the whole tree).
- **Docs and code disagree on headless updates.** The Linux headless guide says
  "`orca serve` never updates itself. In headless mode Orca wires up no auto-updater at all"
  (`docs/reference/headless-linux-server.md:445-448`). The code still calls
  `setupAutoUpdater` in `serve` mode, with `installMode = resolveUpdateInstallMode(isServeMode)`
  (`src/main/startup/main-window-core-services.ts:131`). On Linux both reach the same
  result: `unsupported-headless-serve`, so remote check, download and install are refused.
  The documented upgrade is a scripted operator procedure: download to a temporary name,
  verify, atomic rename, restart, then keep a rollback bundle
  (`headless-linux-server.md:499-505,670-695`).

### 1.10 Security and permissions

- **Who may install.** Any runtime-scope paired device can call `updater.install`, and
  runtime scope already grants full access. Mobile-scope tokens are denied all four
  `updater.*` methods (`src/main/runtime/mobile-rpc-allowlist.test.ts:145-152`).
- **Artifact trust.** Signatures are verified by electron-updater, Authenticode on Windows
  and Squirrel code signatures on macOS, from the HTTPS GitHub feed
  (`updater-setup.ts:158-164`).
- **No host-side policy.** There is no toggle and no audit prompt on the host for
  remote-triggered installs (§1.6).

### 1.11 Failure handling and rollback

- **Error states carry context.** `error` states carry `retryable` and a known `version`
  (`update-status-types.ts:84-94`).
- **Install failures keep their cause.** The updater's own text is appended, redacted and
  capped at 200 chars, "remote clients get nothing but 'it didn't come back'" otherwise
  (`updater-install-support.ts:102-125`). A failure before commit resets the install flags
  and keeps the app running (`updater-install-execution.ts:146-177,181-204`).
- **Supervisor handoff failures are durable.** They are written to the handoff file and
  surfaced by the next process as "The server update did not complete: …"
  (`updater-setup.ts:126-134`, `serve-update-supervisor.ts:276-284`).
- **No automatic rollback of app updates.** For Linux headless, rollback is the documented
  script. It warns: "A rollback is **not** binary-only safe" (newer builds rewrite state),
  so the operator must restore the pre-upgrade profile archive _and_ swap the binary
  (`headless-linux-server.md:697-705`).
- **Transactional rollback exists only in the unwired SSH `orcad` library**
  (`orcad-update-plan.ts:1-20,59-127`):
  - It records `active` and `previous` versions and snapshots state before activation.
  - It defers an update while the terminal census is non-zero or unknown, unless forced.
  - It restores the incumbent if the candidate fails its health gate
    (`orcad-remote-deploy.ts:215-248,323-337`).
  - It classifies a rollback as `clean`, `lossy` or `unsafe`, where `unsafe` means a
    terminal was created after activation.

## 2. BiBCode: what exists today

### 2.1 Contract and RPC surface

`BiBCode: packages/contracts/src/remoteUpdate.ts:5-53`, mirrored byte-for-byte in
`apps/server/src/remote_update.rs:11-66,97-103`:

```ts
RemoteUpdateInstallMode = "interactive" | "manual" | "supervised"; // supervised: schema-reserved
RemoteUpdateSupport = { installMode, reason: "available" | "manual-update-required" | "unpackaged-build" | "updater-unavailable" };
RemoteUpdateSnapshot = { serverVersion, latestVersion: string | null,
  state: "idle" | "checking" | "update-available" | "downloading" | "installing" | "up-to-date" | "error",
  error: string | null, support };
RemoteUpdateInstallError { _tag: "RemoteUpdateInstallError", code: "remote_update_manual_required" }
```

- **Methods.** `updater.status` is a read method. `updater.check` and `updater.install` are
  mutations (`apps/server/src/rpc/methods.rs:164-166`). They require `orchestration:read`
  and `orchestration:operate` respectively (`apps/server/src/auth/scope.rs:57,111-112`).
  Both scopes are in `STANDARD_SCOPES` (`apps/server/src/auth/model.rs:23-26`).
- **Deliberate divergences from Orca** (`docs/plans/remote-servers/remote-servers-spec.md:56-57,278-332`):
  - There is no `download` method: install downloads.
  - Headless servers have no feed.
  - `supervised` is reserved.
  - Scopes reuse the orchestration pair (`phases/phase-7-remote-updates.md:39-48`).
- **What the snapshot lacks:** a download percent, a distinct `downloaded` state, a target
  or install version, a protection stage, and any count of live work.

### 2.2 Server: service, support, descriptor

- **Registration.** `RemoteUpdateService` is registered in the production RPC registry
  (`apps/server/src/production/runtime.rs:448-455`).
- **Manual servers** (`remote_update.rs:142-194`):
  - `status` and `check` return `idle` with `latestVersion: null`.
  - `install` returns the typed `remote_update_manual_required` error.
- **Interactive servers** consult the injected `RemoteUpdateDelegate`. Each call is capped
  at 30 s, and a timeout becomes an `error` snapshot rather than a hang
  (`remote_update.rs:79-92,160-169`).
- **Config.** `ServerConfig.remote_update_support` defaults to `manual` /
  `manual-update-required` (`apps/server/src/config.rs:63,94,108-110`).
- **Descriptors.** All three descriptor producers embed `remoteUpdateSupport` and advertise
  `remoteUpdateControl: true`:
  - the well-known route (`apps/server/src/http.rs:339-379`);
  - `server.getConfig` (`production/control.rs:2149`);
  - the Connect descriptor (`lifecycle.rs:56`).
- **Tests.** End-to-end tests pin the manual surface and the delegate routing
  (`apps/server/tests/remote_update_rpc.rs:64-132,162-206`).

### 2.3 Desktop host: delegate → `DesktopUpdateManager` → update protection

- **Support derivation.** The delegate reports `interactive` / `available` only for a
  release build with a working updater. It reports `manual` / `unpackaged-build` in debug
  builds and `manual` / `updater-unavailable` otherwise
  (`apps/desktop/src-tauri/src/remote_update_delegate.rs:20-37`). It is installed in
  `lib.rs:125-136`.
- **State mapping** turns the desktop updater state into the wire state (`:40-66`):
  - `protecting` or `installing` become `installing`;
  - `downloaded` becomes `update-available`;
  - `downloadPercent` is **dropped**.
- **Install request** (`request_install`, `:98-117`):
  - It spawns `run_remote_install` and immediately reports `installing`.
  - `run_remote_install` checks if needed, downloads, then calls
    `install_update(.., DesktopUpdateInstallInput::default())` (`:120-140`).
  - If the check finds no update, or the download produced no version, it simply `return`s
    (`:124-134`). The caller has already been told `installing`, so it is shown an
    optimistic state that later reverts.
- **Protected install** (`apps/desktop/src-tauri/src/updates.rs:486-742`, living doc
  `docs/architecture/overview.md:691-752`):
  1. Snapshot the running backend set (`:551-556`).
  2. Enter `Protecting` (`:592-602`).
  3. For each running backend, `POST /api/maintenance/update/prepare` with the desktop
     bootstrap token and poll the stage (`:618-665,960-1004`). Prepare drains admitted
     mutations, quiesces runtime-owned work, checkpoints WAL and writes a verified
     `PreUpdate` backup.
  4. Refuse to continue if the **primary** failed protection (`:667-673`,
     `apply_named_secondary_exclusions` `:93-117`).
  5. Commit, then stop the snapshot set (`:678-704`).
  6. Run the Tauri install. Linux and macOS call `app.restart()` (`:706-741,1210-1212`).
     On Windows the plugin launches the NSIS installer (passive mode,
     `tauri.release.conf.json:10-12`) and exits the process
     (tauri-plugin-updater `updater.rs:835-877`).
- **Skipping protection** is allowed only after a failed protection attempt (`:119-124,492-516`).
  The remote delegate never asks for it.
- **Feed and signatures.** Minisign public key and GitHub `latest.json` endpoint
  (`tauri.release.conf.json:7-9`). Dev builds have empty endpoints, which disables the
  updater (`tauri.conf.json:32-35`, `updates.rs:1206-1208`).

### 2.4 The wide-bind gap (inferred from code and tests; not exercised live)

Each step, with the evidence behind it:

- **Maintenance routes need a loopback bind.** `maintenance_routes_enabled` returns true only
  in Desktop mode, with a bootstrap token, and with a loopback or `localhost` bind (or a
  desktop-owned WSL wildcard) (`apps/server/src/maintenance.rs:630-642`). It decides whether
  `lifecycle.rs:383-398` builds the `UpdateMaintenance` owner. The routes themselves are
  always registered (`apps/server/src/http.rs:151-154`) and answer 404 when there is no
  owner (`http.rs:419-420`).
- **A test pins the 404.** A desktop server bound to `0.0.0.0` answers `prepare` with
  **404** even with the correct token. The WSL-marked case answers 200
  (`apps/server/tests/production_maintenance.rs:438-481`).
- **Sharing widens the bind.** **Share this host → Another device** rebinds the native
  primary to `0.0.0.0` (`apps/desktop/src-tauri/src/backend.rs:45,2774-2796`,
  `server_exposure.rs:393`, `docs/architecture/overview.md:665-680`).
- **A 404 becomes a protection failure, which aborts the install.** `decode_maintenance_response`
  turns the 404 into "Could not prepare {label} for update protection (HTTP 404)."
  (`updates.rs:1063-1090`). The primary is marked Failed, and the install ends in
  `finish_failed_install`. That leaves the host at `status: error`, `phase: failed` with the
  update still downloaded (`:667-673,768-792`).
- **The remote client cannot complete the install.** It sees **Update status error**, and
  its **Update** button disappears because it only renders for `update-available`
  (`ConnectTab.tsx:339-345`). A remote **Check** is still admitted from `status: error`
  (`can_begin_check`, `updates.rs:892-900`) and brings the button back, but a retry loops
  into the same 404. The client has no bypass: the delegate hardcodes the default input.
- **The limitation is documented.** "A wide-bound native primary does not expose the
  desktop-only maintenance API. Update protection therefore degrades while sharing until
  exposure returns to loopback" (`docs/architecture/remote.md:651-654`). The current-state
  audit flagged the same conflict (`docs/plans/remote-servers/bibcode-current-state.md:463-471`).

**Consequence.** The shipped remote install can complete only when the host keeps its
loopback bind: a client behind an SSH tunnel, the Connect relay's managed endpoint, or a
Custom address fronted by a proxy. The common LAN/Tailscale "Another device" topology fails
at protection every time.

### 2.5 Client runtime and UI

- **Client atoms** (`packages/client-runtime/src/state/remoteUpdates.ts:13-15,39-65,77-104`,
  instantiated in `apps/web/src/state/remoteUpdates.ts:1-5`):
  - A per-environment `updater.status` query with `staleTimeMs: 30_000`.
  - A `check` command with a 30 s deadline, single-flight per environment.
  - An `install` command, single-flight.
  - A fan-out helper capped at 2.
- **The query does not follow the flow.** It only runs while the connection is `connected`:
  the generation stream drops every other phase, so the atom keeps its last value through
  disconnects (`packages/client-runtime/src/state/runtime.ts:523-543`). It revalidates on
  mount and whenever the generation changes, and it has **no refresh interval**
  (`:547-567`). Nothing refreshes it during a check, download or install.
- **Sidebar context card (the screenshot)** (`apps/web/src/components/Sidebar.tsx:291-324`,
  `sidebar/EnvironmentContextCard.tsx:83,99-111`, `environmentContextCard.logic.ts:46-72`):
  - It renders the `ServerUpdateBadge` and a menu: **Disconnect**, **Check for updates**
    (only when `remoteUpdateControl` is set), **Manage…**.
  - A check calls `updater.check` and then refreshes the status query.
  - There is **no install entry**.
  - The card's dot passes `updateAvailable: false` (`environmentContextCard.logic.ts:65`).
    Only the rail turns amber (`EnvironmentRail.tsx:109-125`).
- **Settings → Remote Servers → Connect tab** (`apps/web/src/components/settings/remote-servers/ConnectTab.tsx`):
  - Each row shows the version, the badge, a collapsible **Manual update steps**
    (`:216-220,283,309-331`), a **Check** button, and an **Update** button when
    `installMode === "interactive"` and the state is `update-available` (`:334-345`).
  - A manual-required install error flips the row to manual (`:445-475`).
  - A batch **Check for Server Updates** runs across capable environments (`:755-776,1521`).
- **No flow UI.** There is no confirmation, no progress, no running-work warning, and no
  post-restart verification.
- **Manual copy is generic.** It says to replace "the binary on PATH" and re-run
  `bibcode serve` (`ServerUpdateBadge.tsx:69-79`). That is wrong for package installs and
  for `bibcode service` installs.

### 2.6 What happens to running work

- **Everything the server owns is stopped.** An update quiesce stops providers, terminals,
  managed endpoints, delivery and orchestration effects. It captures exact process
  identities and kills whatever remains in the runtime-owned tree
  (`apps/server/src/production/runtime.rs:598-635`, `overview.md:725-740`).
- **No process survives a restart.** There is no daemon that outlives the server, so a
  restart ends in-flight agent turns and PTYs.
- **What survives is durable state.**
  - Queued messages "survive reloads and server restarts" (`overview.md:1027-1034`).
  - A dead provider session relaunches on the next delivery, through the missing-session
    path and the persisted resume cursor (`docs/architecture/providers.md:110-131`).
  - Terminals are recreated on attach, which is a documented gap
    (`docs/architecture/rpc-and-orchestration.md:1788-1791`).
- **Headless services lose their children too.** The per-user systemd unit sets no
  `KillMode` (`apps/server/src/service_manager/definitions.rs:80-97`), so systemd's
  default `control-group` kills provider children on any service restart.

### 2.7 Restart and reconnect after an install

- **Reconnect** follows the supervisor's 1/2/4/8/16 s backoff
  (`docs/architecture/connection-runtime.md:343-347`).
- **The badge is stale across the restart.** It shows the last `installing` snapshot until
  the generation changes. After reconnecting, the new desktop process reports `idle`, which
  renders as **Status unavailable** (§3).
- **Nothing identifies the new process.** The descriptor has only `serverVersion` and
  `storageInstanceId` (`packages/contracts/src/environment.ts:68-82`), with no per-boot id,
  so the client cannot prove that a replacement process is answering.
- **The desktop port can move.** The desktop re-picks the first free port from 3773
  (`backend.rs:46,551-558,2811-2818`).
- **The widened bind is not immediate.** A fresh native process "starts local-only"
  (`overview.md:677-680`). It re-widens only after the host renderer's
  `ShareExposureReconciler` runs (`apps/web/src/AppRoot.tsx:20-21,154`).
- **Browser clients keep the old bundle.** A client served by the updated server keeps its
  old JS until reload. `versionSkew.ts` only surfaces "Version drift", with no reload
  prompt (`apps/web/src/versionSkew.ts:26-56`, `ConnectTab.tsx:288-293`).

### 2.8 Headless `bibcode serve`: distribution and update path

- **Release assets** (`.github/workflows/release.yml:485-667`): standalone archives
  (`tar.gz`/`zip`, each with a versioned directory holding `bibcode`, `web/`, README and
  LICENSE), plus Linux `.deb`/`.rpm` built with nFPM. `SHA256SUMS` is mandatory. Minisign
  server signatures are _optional_ until a signing identity is configured
  (`docs/user/server-installation.md:42-62`, `release.yml:759-786`).
- **Package paths.** The `.deb`/`.rpm` own `/usr/bin/bibcode`, `/usr/share/bibcode/web` and
  `/usr/share/doc/bibcode-server` (`server-installation.md:58-62`,
  `scripts/server-package-contract.test.ts:14-17`).
- **Web assets.** The server finds them adjacent (`web/` next to the binary, an archive
  install) or at `<prefix>/share/bibcode/web` (a package install)
  (`apps/server/src/static_assets.rs:52-72`).
- **Per-user service.** `bibcode service install` writes one of the following
  (`server-installation.md:64-93`, `definitions.rs:63-179`):
  - a systemd **user** unit with `Restart=on-failure` and `RestartSec=2`;
  - a LaunchAgent with `KeepAlive`;
  - a Windows scheduled task started at logon. The invocation is
    `schtasks /Create /F /TN … /SC ONLOGON /RL LIMITED /TR …` and configures no
    restart-on-failure (`apps/server/src/service_manager/manager.rs:359-373`).
- **Updates are documented as manual.** "stop the process, replace the extracted
  distribution …, and start it again". Packages upgrade by installing the newer local
  package (`server-installation.md:31-39`).
- **The Tauri feed cannot serve a headless update.** It lists only desktop assets
  (`.app.tar.gz`, `.AppImage` and `.exe`), and the desktop releases ship only DMG, AppImage
  and EXE (`scripts/build-tauri-update-manifest.ts:84-89,97-104`, `release.yml:452-476`).
- **SSH-launched servers** need `bibcode` on the remote `PATH`. They start with `nohup`
  and are reused through PID and port files (`apps/desktop/src-tauri/src/ssh.rs:63-150`).
  Nothing restarts them except the next desktop launch attempt.

### 2.9 Failure handling and rollback building blocks

- **Protection failures always restart the prior set.** A failed prepare, cancel, commit,
  stop or installer step restarts exactly the backends that were running before the
  install (`overview.md:742-752`, `updates.rs:667-741`).
- **Migrations are backed up first.** Opening a store with pending migrations first writes
  a verified `PreMigration` backup (`apps/server/src/persistence/store.rs:291-311`,
  `persistence/backup.rs:40-43`).
- **Restore exists as a CLI.** `bibcode storage inspect|restore|start-empty` exist
  (`apps/server/src/config.rs:448-600`).
- **What is missing:** an activation record, an automatic binary rollback, and any health
  gate on a new server version.

## 3. What "Status unavailable" means in the screenshot

The string appears in three places with different meanings:

| Where                                    | Condition                                                                                                                                                      | Evidence                                                                        |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `ServerUpdateBadge` (card, settings row) | `snapshot === null`: not connected, first fetch pending, or query failed. `useEnvironmentQuery` returns `data: null` on failure.                               | `ServerUpdateBadge.tsx:14,37`; `apps/web/src/state/query.ts:27-40`              |
| `ServerUpdateBadge`                      | `state === "idle"` with `installMode !== "manual"`, i.e. an interactive host whose updater has not finished a check. A manual host renders **Manual updates**. | `ServerUpdateBadge.tsx:26-27`                                                   |
| Connect tab, next to the version         | No version, no compat badge, and a connection error: "failed probe without a cached descriptor". A failed batch check also forces the snapshot to `null`.      | `ConnectTab.tsx:221-222,263-265,468-469`; `docs/architecture/remote.md:481-482` |

**Why a healthy desktop host shows it:**

- A new `DesktopUpdateInner` has `status: None`, which serializes as `"idle"`
  (`updates.rs:146-163,1280`). The delegate maps that to `Idle`
  (`remote_update_delegate.rs:47-55`).
- The first background check runs 15 s after launch, then every 30 minutes
  (`updates.rs:30-31,1160-1193`).
- Every host launch therefore starts as **Status unavailable**. That includes the restart
  right after a remote update.
- The card's query never refreshes while the card stays mounted (§2.5), so the label can
  outlive the host's own later `up-to-date` state indefinitely.
- **Check for updates** runs a real check, and the follow-up refresh shows **Up to date**.
  That is exactly the pair of labels the user observed.

**What the screenshot implies:** `Ai-server` is a desktop-hosted BiBCode, in `interactive`
mode. A headless `bibcode serve` answers `check` with `idle`/manual and can only show
**Manual updates** once loaded (`remote_update.rs:142-148,179-185`).

**Is it a bug?** Not in the transport or the data: every snapshot is truthful. It is a
**presentation and state-model defect**:

1. One label covers "not loaded", "query failed" and "never checked". That breaks UI.md's
   "Errors should help users regain control" and "Say what failed … and what the user can
   do next" (`UI.md:178-184`).
2. The card never refreshes and never shows the underlying error.
3. The desktop updater state resets to `idle` on every launch.

A fix is small (§5.1).

## 4. Gap analysis

| Area                               | Orca                                                                  | BiBCode today                                                                               | Gap / impact                                                                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Who checks                         | Host's own feed, via RPC                                              | Same for desktop hosts; headless hosts have no feed                                         | Headless servers cannot even report "update available" (`remote.md:485-490`).                                                                                 |
| Steps                              | check / download / install as separate RPCs                           | check / install; install downloads (by design, spec §4.5)                                   | No "download now, restart later". Acceptable, but it rules out staging while agents run.                                                                      |
| Progress                           | `downloading.percent`, polled every 500 ms                            | Desktop tracks `download_percent` (`updates.rs:405-406,429-435,1287`); the mapping drops it | Users see only "Updating…" (`ServerUpdateBadge.tsx:34`).                                                                                                      |
| Install entry points               | Row button, dialog, "Update all", status bar                          | Settings row **Update** only; the card has **Check for updates** only                       | The card that shows the badge cannot act on it.                                                                                                               |
| Confirmation and live-work warning | Dialog with live tab and pane counts                                  | None                                                                                        | A click restarts someone's host and kills its agents without warning.                                                                                         |
| Restart verification               | New `runtimeId` plus target version, 3-min budget, failure probe      | None; no boot id                                                                            | A failed or slow restart is indistinguishable from success. The stale `installing` badge lingers.                                                             |
| Running work across restart        | Daemon PTYs survive (desktop and serve)                               | All provider and PTY processes are stopped; durable queue and resume-on-next-message        | BiBCode can only promise "stopped, resumable", never "keeps running".                                                                                         |
| Wide-bound desktop hosts           | Works (no maintenance-API coupling)                                   | Protection 404s and the remote client cannot bypass (§2.4)                                  | The main direct-share topology cannot remote-install.                                                                                                         |
| Headless self-update               | macOS supervised serve only; Linux manual                             | Manual only; `supervised` reserved                                                          | Parity with Orca on Linux. Beyond Orca: archive installs under `bibcode service` could be supervised.                                                         |
| Manual guidance                    | Tailored copy (deb/rpm vs service manager vs dev build)               | One generic script                                                                          | Wrong steps for package or service installs. The server can tell install types apart (`static_assets.rs:52-72`).                                              |
| Target version                     | Host feed's offer; the client's version gates eligibility and channel | Host feed's latest                                                                          | Both can move a server past the client. Orca at least never calls a lagging server "current". BiBCode relies on the protocol window (`environment.ts:65-66`). |
| Authorization                      | Runtime-scope device (full access); mobile denied                     | `orchestration:operate` (standard scope)                                                    | Equivalent. Neither has host-side consent or an audit entry.                                                                                                  |
| Status freshness                   | Refreshed per check and poll; the dialog re-checks when opened        | Query only on mount or reconnect                                                            | "Status unavailable" sticks (§3).                                                                                                                             |
| Optimistic state                   | Install accepted only when `downloaded`                               | `request_install` reports `installing` before the flow even checks                          | A silent revert when no update exists or the download fails (`remote_update_delegate.rs:107-114,124-134`).                                                    |
| Rollback                           | Operator script (Linux); unwired `orcad` library                      | Verified PreUpdate and PreMigration backups plus `storage restore`; no binary rollback      | Good data-side foundation. No automatic binary or activation rollback.                                                                                        |

## 5. Recommended design direction

These are constraints from `AGENTS.md`, not choices:

- Privileged _desktop renderer_ operations cross `DesktopBridge`.
- Application traffic uses typed HTTP/WS RPC.
- `packages/contracts` stays schema-only.
- No production Node runtime and no native helper sidecar.
- Wire changes are additive and decode-defaulted.
- Non-trivial new architecture needs an approved design, so §5.3 and §5.4 are proposals
  for that design.
- A remote-originated request cannot use `DesktopBridge`. The server→host delegate seam
  is the sanctioned path (`remote-servers-spec.md:309-315`).

### 5.1 Fix what is shipped (small; no new architecture)

1. **Badge semantics** (`apps/web`). Split the `unknown` variant into three:
   - **Checking…**: query pending.
   - **Not checked**: interactive or supervised host in `idle`, with **Check** as the
     obvious next step.
   - **Can't reach updater**: query failed. Show the error in a tooltip and offer
     **Retry**.

   Keep **Manual updates** for manual hosts.

   Then refresh the snapshot:
   - once after a successful reconnect;
   - on a short interval while `state ∈ {checking, downloading, installing}`, in the
     client-runtime atom (for example through the existing `refreshIntervalMs` option,
     `runtime.ts:565-567`), stopping in terminal states.

   This needs a UI.md review and a `vercel-react-best-practices` review.

2. **Card actions.** When `installMode === "interactive"` and the state is
   `update-available`, add **Update to v{latest}…**. It opens the same confirmation as
   Settings (§5.2). For manual hosts, replace **Check for updates** with **Show update
   steps**, because a check on a manual host changes nothing (`remote_update.rs:179-185`).
   Pass `updateAvailable` into the card's dot the same way the rail does.
3. **Delegate honesty** (`apps/desktop`). Do not report `installing` before the flow has
   actually started. When `run_remote_install` finds nothing to install, or the download
   fails, leave or record a terminal `up-to-date`/`error` state instead of a silent
   `return`.
4. **Tailored manual steps.** Put an additive, decode-defaulted `installKind` on
   `RemoteUpdateSupport`: `archive`, `system-package`, `user-service`, `ssh-launched` or
   `unknown`. The server derives it from its executable path, its static-dir source and its
   service presence. The UI then shows the right commands, for example
   `sudo apt install ./bibcode-server_<v>_<arch>.deb` after a `SHA256SUMS` check, or
   replace the archive and run `bibcode service` restart steps. Orca's help strings are the
   model (`RemoteServerUpdateStatus.tsx:95-112`).

### 5.2 Make remote install observable and safe (contract plus client runtime)

1. **Contract** (`packages/contracts` plus the Rust mirror). Add only decode-defaulted
   fields. **Do not add new `RemoteUpdateState` literals.** An older client's
   `Schema.Literals` decode would fail on them and blank the whole snapshot. Orca's
   equivalent rule is "new opcodes must be negotiated". Proposed fields:
   - `downloadPercent: number | null`, from the existing desktop value.
   - `targetVersion: string | null`.
   - `installStage: string | null`, the protection stage the desktop already emits
     (`updates.rs:57-66`).
   - `activeWork: { runningTurns, liveTerminals, queuedMessages } | null`, or a small
     read RPC if computing it is expensive.
   - A per-process `bootId` on `ExecutionEnvironmentDescriptor`.
2. **Coordinator** (`packages/client-runtime`, shared by the browser and desktop clients).
   Port Orca's `runRemoteServerUpdate`, `waitForReplacementRuntime` and the failure probe
   (§1.4):
   - `install`;
   - poll `updater.status` with bounded per-call deadlines;
   - on disconnect, wait for the supervisor to reconnect under a reconnect budget
     (Orca: 3 minutes);
   - succeed only when `bootId` has changed **and** `serverVersion ≥ targetVersion`;
   - while the _old_ boot id still answers, surface its `error` snapshot text.

   Keep the existing cap of 2 concurrent environments.

3. **Confirmation** (`apps/web`, UI.md: "For destructive actions, explain the consequence
   briefly and offer a clear cancel path", `UI.md:125-131`). One sentence with real
   numbers:

   > "Updating {name} restarts it. 2 running agents and 3 terminals on that server will be
   > stopped; their conversations and queued messages are kept and resume on the next
   > message."

   Then **Update** / **Cancel**. Show progress and stage text, and a final
   "Updated to vX" or an actionable failure.

4. **Browser mode.** When the connection that serves the UI reconnects with a different
   `serverVersion`, prompt a reload. Otherwise the old bundle keeps talking to the new
   server (§2.7).

### 5.3 Wide-bound desktop hosts (needs design approval)

Options that keep the "no maintenance API on a native wildcard bind" invariant
(`overview.md:706-710`):

- **(a) In-process protection.** The delegate already runs in the host process, and the
  primary backend is in-process. The desktop could invoke the primary's prepare and commit
  through an in-process handle instead of loopback HTTP, while keeping HTTP for WSL and
  external secondaries. This changes the protection transport and needs its own tests.
- **(b) Narrow first.** Narrow the primary to loopback for the protection phase. The
  renderer reconciler already re-widens after restart (`AppRoot.tsx:154`). The cost is an
  extra rebind, and the remote client drops earlier.
- **(c) A loopback-only maintenance listener** beside the wide listener. This adds a new
  listening surface.

Whichever option is chosen, add a **host-side policy and notice**. Two gaps drive this:
Orca's host lets any runtime device restart it silently (§1.6), and the BiBCode host's
local user currently gets no warning either. The policy should include:

- a desktop setting "Allow paired devices to install updates", read by the delegate and
  edited through `DesktopBridge` in the host renderer;
- a host toast naming the requesting device;
- an operational-log entry.

### 5.4 Headless `supervised` mode (needs design approval)

- **Feasible scope: user-owned archive installs running under `bibcode service`.**
  - **Feed.** Publish a server manifest, for example `bibcode-server-latest.json` next to
    the archives, signed with the server minisign key. Pin that key in the binary, and make
    server signatures **mandatory** first; today they are optional
    (`server-installation.md:52-56`). Tauri's `latest.json` cannot be reused, because it
    lists only desktop assets (§2.8).
  - **Stage.** Download into `~/.bibcode/server-releases/<version>/`. Verify SHA256 and the
    minisign signature, then write a completion sentinel. Orca's orcad install transaction
    is the model (`orcad-remote-deploy.ts:105-144`).
  - **Activate.** Run the existing quiesce plus a verified `PreUpdate` backup, called
    in-process rather than through the desktop-only HTTP routes. Switch an activation
    record or stable launcher path atomically. Exit with a dedicated **non-zero** status:
    systemd `Restart=on-failure` does not restart a clean exit 0 (`definitions.rs:93-94`).
    launchd `KeepAlive` restarts any exit. The Windows scheduled task is created with no
    restart-on-failure (`manager.rs:359-373`), so it needs task restart settings or a
    same-binary supervisor mode, which is a `AGENTS.md` sidecar question (§6).
  - **Health gate and rollback.** If the new version does not publish readiness with the
    expected version within N seconds, fall back to the previous activation. This follows
    Orca's `restoreIncumbent` and activation record (`orcad-remote-deploy.ts:215-248`).
    Data rollback uses the verified backups BiBCode already writes (§2.9).
- **System packages stay manual**, as in Orca. `/usr/bin/bibcode` is root-owned and the
  service runs as the user (`server-installation.md:58-68`). The Tauri plugin's
  `pkexec`/`sudo` prompts (`tauri-plugin-updater updater.rs:1177-1217`) would pop up on an
  unattended host.
- **SSH-launched servers.** The desktop can drive the update over SSH instead: upload a
  verified archive, then relaunch through the existing launch script (`ssh.rs:63-150`).
  This is the working analogue of Orca's unwired SSH `orcad` deploy.
- **Optional "update when idle".** A server-side deferral while `activeWork` is non-zero,
  with an explicit force. It follows Orca's `planOrcadUpdate` defer/force decision
  (`orcad-update-plan.ts:59-127`). It fits BiBCode better than Orca, because BiBCode has no
  daemon to carry work across the restart.

### 5.5 Key risks

- **Restarting a server that hosts running agents.**
  - In-flight turns and PTYs die (§2.6).
  - Mitigations: show real counts in the confirmation, offer update-when-idle, rely on the
    durable queue, and resume on the next message. Never auto-install.
  - Orca's daemon-outlives-server model is out of reach without a new process
    architecture.
- **Updating a server you are connected through.** Four cases:
  - **Browser page served by that server.** The page goes down and comes back with a new
    bundle version, so the client must reload.
  - **Desktop host.** Its local user loses the app mid-work. On Windows, a passive installer
    window appears on the host.
  - **Connect relay.** The managed endpoint is quiesced (`runtime.rs:604`) and re-registers
    after the restart.
  - **Port and exposure.** A desktop host can come back on another port, and starts
    loopback-only until its renderer re-widens (§2.7).
- **Platform packaging.**
  - The AppImage must be in a writable location for in-place replacement.
  - `.deb`/`.rpm` are root-owned.
  - macOS desktop builds are ad-hoc signed (`release.yml:446-450`).
  - Windows cannot overwrite a running exe, and the scheduled task configures no
    restart-on-failure (`manager.rs:359-373`).
  - systemd user units need lingering and kill the whole cgroup.
- **Version skew.** Installing the host feed's "latest" can move a server past older
  clients, in Orca as much as in BiBCode, since both install the feed's offer. Surface the
  compatibility verdict for the target before installing. Like Orca, gate eligibility on
  the client's version, so a server that lags the client is never shown as current.
- **Supply chain.** Self-update turns any feed or signing compromise into remote code
  execution on every server. Mandatory pinned signatures and HTTPS-only feeds are
  prerequisites.

## 6. Open questions

1. Should a paired client be able to restart a desktop host with **no** host-side consent?
   Orca allows it; BiBCode currently does too, implicitly.
2. Target selection: keep installing the host feed's latest, as both products do today, or
   pin to "match this client's version"? The Tauri feed has no pinned-version endpoint
   today. Should BiBCode adopt Orca's rule that a server lagging the client is never
   shown as current?
3. Is a same-binary supervisor mode (`bibcode service run` supervising `bibcode serve`)
   acceptable under the "no native helper sidecar" rule? Windows needs it or scheduled-task
   restart settings.
4. Which `supervised` install kinds are in scope for v1: archive only, or also the macOS
   LaunchAgent and Windows?
5. Should BiBCode add `updater.download` to stage an update while agents run, and restart
   later or when idle?
6. How does an older binary behave against a store a newer one has migrated? Is
   `bibcode storage restore` of the `PreMigration` backup the supported downgrade path?
7. Confirm `Ai-server`'s host type (desktop vs headless) to close §3. The Connect-tab row
   shows **Manual update steps** only for manual hosts. Also try the wide-bind install
   (§2.4) live before relying on that finding.
