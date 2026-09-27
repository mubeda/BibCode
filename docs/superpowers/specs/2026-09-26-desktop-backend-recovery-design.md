# Recovering the local server in the app after a failed update-recovery restart

Status: **Approved by the user on 2026-09-26**: the proposal below, without automatic retry.

**Input.** A residual found while implementing the SSH watchdog follow-up
([`2026-09-26-ssh-watchdog-and-windows-drain-design.md`](./2026-09-26-ssh-watchdog-and-windows-drain-design.md)),
where fix round SS15 added the opt-in listener bind retry.

Before the desktop runs the platform installer, it stops every running backend. If the install
fails or is cancelled, it restarts the exact prior running set. SS15 lets those restarts retry a
bind that finds the port still in use for up to 3 s. When a restart still fails, nothing in the app
brings the server back; only restarting BiBCode does.

Evidence is from reading `apps/desktop/src-tauri/src/backend.rs` at `67373eaf` plus the uncommitted
SSH package. Nothing was measured on Windows or macOS.

## Problem

- `stop()` (`backend.rs:1535`) clears every backend slot. A restart that then fails
  (`restart_update_snapshot`, `backend.rs:952`) records nothing, so the environment is no longer
  registered.
- Retrying the project-data restart, through `retry_project_data` (`data_safety.rs:619`) and
  `restart_after_commit` (`backend.rs:739`), fails with "not registered". An exposure restart finds
  nothing to restart. Only restarting BiBCode brings the server back.
- The error is a string by the time it reaches the update flow, so the app cannot tell a port
  conflict, which the user can fix, from other failures.

Only update recovery needs this. Project-data restarts already recover through their dialog's Retry,
and crash restarts retry on their own.

## Proposal

1. **Keep the failed plan registered** (`backend.rs`).
   - In `restart_update_snapshot`, record each failed plan with
     `record_plan_error_with_classification` (`backend.rs:1737`), as a failed first start already
     does.
   - The slot keeps its exact plan and error. The renderer gets no connection details for it.
   - `retryProjectData` → `restart_after_commit` then restarts it unchanged, and an exposure restart
     revives it too. WSL secondaries work the same way.
2. **Detect "port in use" without string matching.** Before `start_managed_backend` turns the server
   error into a string, it checks for `ServerError::Bind` with `AddrInUse` and produces a typed
   "port in use (port)" outcome.
3. **Tell the renderer.**
   - Add `backendRecovery: [{ environmentId, label, reason: "port-in-use" | "other", port }]` to the
     desktop update state. It is set in `updates.rs` and declared by `DesktopUpdateState` in
     `packages/contracts/src/ipc.ts`.
   - Also emit `desktop:project-data-status-changed` (`backend.rs:50`) for each failed environment.
4. **Action.** The update dialog and the failure toast get a **Restart server** button.
   - It calls the existing `retryProjectData(id)` for each failed environment, then reconnects that
     environment. No new privileged command is added.
   - While the server is stopped, the update protection step fails ("primary not running"). So
     **Retry installation** stays disabled, with a reason, until Restart server succeeds.
   - `retry_project_data` wraps errors as "The selected project-data backend could not restart"
     (`data_safety.rs:633`). Generalise that wording before the update dialog shows it.
5. **Copy (it says what to do).**
   - Title: "Update not installed".
   - Port in use: "BiBCode's local server couldn't restart: port 3773 is in use by another program.
     Quit that program, then choose Restart server." The real port replaces 3773.
   - Other causes: "BiBCode's local server couldn't restart. Choose Restart server. If that fails,
     restart BiBCode."
   - Buttons: **Restart server** (primary), **Details** (the raw error) and **Close**. If Restart
     server fails again, the dialog shows the new reason and offers **Restart BiBCode**.

## Alternatives

- **A. A "stopped" status in the project-data dialog.** The smallest UI change, but that dialog is
  about storage recovery, which doesn't match a port conflict. It would also mix store health and
  running state in one status.
- **B. A dedicated `restartStoppedBackends` command.** A clearer name, but one more privileged
  command that does what `retryProjectData` already does in Rust.
- **C. Automatic retry through `schedule_restart`.** Heals transient causes with no user action, but
  loops silently every 5 s when the cause is permanent. It still needs the UI above. The user chose
  not to include it now; it can be added later.
- **D. Move to a free port.** Heals port conflicts, but moves the server's address. That breaks
  network exposure, firewall rules, pairing links and other devices' saved addresses, and ignores
  `BIBCODE_PORT`.

## Affected files

- `apps/desktop/src-tauri/src/backend.rs`, `updates.rs` and `data_safety.rs` (the error wording).
- `packages/contracts/src/ipc.ts`.
- `apps/web/src/components/desktop/UpdateProtectionDialog.tsx`,
  `apps/web/src/components/sidebar/SidebarUpdatePill.tsx` and
  `apps/web/src/components/desktopUpdate.logic.ts`.
- `docs/architecture/overview.md` ("Desktop update protection").
- `docs/testing/{linux,macos,windows}-desktop.md` (one manual check).

## Tests

- `backend.rs`:
  - a failed update restart (port held past the window) leaves the primary registered and stopped,
    with no connection details for the renderer;
  - `retry_project_data` restarts it on the same port once the port is freed;
  - an exposure restart also revives it.
- `updates.rs`: a failed install plus a failed recovery fills `backendRecovery` and emits the status
  event.
- Contracts: the new field decodes.
- Web: copy selection; Restart server calls retry, then reconnects; Retry installation stays
  disabled, with its reason, while the server is stopped.
- Runbooks: one manual check per desktop runbook.

## Open implementation question

Keeping the failed plan means the primary's connection details disappear while the renderer is
connected. Today that only happens at startup, so the implementation must check how the renderer
handles it and keep the window usable.

## Sequencing

Implement after the SSH watchdog package is committed, because it edits the same `backend.rs` and
`updates.rs` regions. Remote server updates (task 4) also edit `updates.rs`, so the two changes run
one after the other, not in parallel.
