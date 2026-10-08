# Cross-client center panels — design

Status: approved (Option A, 2026-10-08). Close-everywhere and chat-panel
inclusion were approved together with it.

## Problem

Each client stores which center panels a host thread shows in its own
`localStorage` (`bibcode:center-panel-state:v1`). A second client connected to
the same server never shows an AI terminal or chat panel that another client
opened, even though the server already broadcasts terminal metadata and panel
threads to every client. With the Default Agent set to AI terminal, a new
worktree's main panel is replaced by a terminal only in the creating browser,
so other clients show an empty chat.

A two-context headless-browser reproduction showed the layout store as the only
difference: copying client A's `localStorage` into client B makes B show A's
terminal.

## Decision

The server marks what each session is; every client adopts the panels it is
missing from that server data.

1. **Terminal sessions.** `terminal.open` and `terminal.attach` accept an
   optional `centerPanel: boolean`. The server keeps the marker (sticky once
   true) and the launch command on the session. `TerminalSummary` gains
   `centerPanel` (decoding default `false`) and an optional `command`. The
   marker is required: right-panel drawer shells are also server sessions under
   the same host thread and must not become center tabs elsewhere.
2. **Chat panels.** `worktree.createPanel` records the host thread on the
   panel thread. `ThreadCreatedPayload`, `OrchestrationThread`, and
   `OrchestrationThreadShell` gain optional `hostThreadId`, persisted in
   `projection_threads.host_thread_id`.
3. **Web adoption.** The per-environment `ThreadLifecycleReconciler` adopts
   panels on transitions: when a center terminal session or a panel thread is
   first seen by this client (including the first snapshot after load), it is
   added as a tab to its host thread's focused group if the layout lacks it.
   Terminal ids reserved by an in-flight local creation are skipped; that
   creation places its own surface. When a known center terminal session is
   removed from the server, its surface is removed. Chat-panel removal already
   follows thread deletion.
4. **Closing.** Closing a center terminal tab already retires the session, and
   closing a chat panel already deletes its thread, so the server removal
   closes the panel on every client.

Adoption happens only on first sight, so a client that closed a tab is not
handed it back by later status updates for the same session.

## Trade-offs

- Every client shows the same panels; split arrangement and tab order remain
  per client. Adopted panels open as tabs in the focused group.
- Option B (one authoritative window publishes the whole layout graph, as Orca
  does) would also mirror arrangement but conflicts with BiBCode's per-window
  terminal size ownership and is much larger.
- Terminal scrollback is still in memory only and is lost when the server
  restarts (unchanged).
- Older servers omit the new fields; clients then behave as before (no
  adoption) because `centerPanel` decodes to `false` and `hostThreadId` is
  absent.

## Validation

- Contracts decoding tests for the new fields and defaults.
- Server tests: summaries carry `centerPanel`/`command`; panel thread shell
  carries `hostThreadId` through projection rebuild.
- Web tests for the reconciler: adoption on first sight, reservation skip,
  no re-adoption after local close, removal on server remove, drawer shells
  ignored.
- Two-client browser loop (`xclient.mjs`) goes from FAIL to PASS for both an
  AI terminal and a chat panel.
