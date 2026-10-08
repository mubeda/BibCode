# Resume continuity — design

Status: approved for implementation by the user on 2026-10-08 ("do the
idle-suspension fix and implement t3 code gaps"). T3 Code
(`/work/github/t3code`) is the reference implementation for parts 3–5.

## Problems

1. **Idle suspension kills live background work.** The supervisor suspends a
   provider session 60 s after a completed turn when the projection shows no
   delivery, no `running`/`starting` status and no active turn
   (`session_is_confirmed_idle`). Suspension shuts the driver down, which kills
   Claude Code background subagents that were still running and reporting
   activity. Observed: three subagents stopped exactly 60 s after the turn that
   started them completed, while `activity.native` events kept arriving.
2. **A clean server shutdown discards resume state.** `shutdown_sessions`
   deletes every `provider_session_runtime` row, so after an ordinary restart or
   update every thread starts a new provider conversation.
3. **Failed resumes lose context silently.** Codex falls back to `thread/start`
   without notice; Claude, Cursor and OpenCode retry the same failing resume
   forever; a frozen delivery whose cursor is gone is sent to a new conversation
   with only a muted line.
4. **No way to continue CLI sessions.** Sessions started in Claude Code or
   Codex outside BiBCode cannot be opened in BiBCode.
5. **Closing a chat panel destroys it.** The panel thread is deleted, with its
   history and resume cursor, and cannot be reopened. Deleting a host thread
   without a worktree leaks its panels.

## Decisions

### 1. Busy while provider subagents run

The per-session in-memory activity state (`SessionEntry.activity_lifecycle`,
updated by the event pump from projected batches) records the ids of actors
and work items whose lifecycle is `starting` or `running`, plus the time of the
last provider event. The idle-deadline evaluation treats a session as busy and
re-arms when, in addition to today's checks, it has such live activity **and**
the provider emitted an event within the last 30 minutes. `waiting` and
`unknown` do not count (idle Codex children map to `waiting`). The removal path
(`SuspendSessionForRemovalIfCurrent`) keeps its current behavior.

Rejected: reading `ActivityProjection::snapshot` counts — a SQLite read whose
records are never interrupted when a session stops, so a crash would leave the
thread busy forever. The 30-minute quiet cap bounds sessions whose activity
never reports a terminal state (a missed `SubagentStop`, a Codex background
terminal that exits between reconciliations).

### 2. Shutdown suspends instead of deleting

`shutdown_sessions` persists each detached session as `suspended` with its
resume cursor, exactly as idle suspension does, guarded by
`upsert_provider_session_runtime_if_thread_live`. Explicit stop, thread delete
and restart are separate paths and keep deleting their rows.

### 3. Resume failures restart with a context handoff

- Codex keeps its recoverable `thread/start` fallback. Cursor falls back from a
  failing `session/load` to `session/new`; OpenCode falls back to a new session
  only on HTTP 404 (other statuses still fail and retry). Claude resumes only
  when a transcript named `<sessionId>.jsonl` exists under
  `<claude config dir>/projects/*/`; otherwise it starts a new session. When the
  config directory cannot be resolved it keeps today's behavior.
- `launch_session` detects a fresh conversation when the request carried a
  resume id and the started session reports a different one. That, and the
  existing lost-cursor path (`AcceptedInNewConversation`), set a one-shot
  pending handoff on the session.
- The next delivered turn prepends a bounded transcript of the thread's earlier
  delivered messages (oldest first, last 40 messages, 24 000 characters,
  excluding the current message) inside a `<bibcode_thread_context>` block.
  Turns whose text starts with `/` (provider slash commands) are sent unchanged
  and leave the handoff pending. A thread with no earlier messages consumes the
  handoff silently.
- A thread activity (tone `info`, kind `provider.context-handoff`) tells the
  user: "Couldn't resume the previous <provider> conversation. Started a new one
  with a summary of this thread." The new-conversation delivery notice says the
  agent received a summary of earlier messages.

Rejected: a model-generated summary (cost, latency, a provider call that can
itself fail). T3 Code uses a transcript-derived handoff with a token budget.

### 4. Import CLI sessions per project

- `agentSessions.scan { projectId }` lists Claude Code (`<claude config
  dir>/projects/*/*.jsonl`) and Codex (`<codex home>/sessions/YYYY/MM/DD/
  rollout-*.jsonl`) sessions from the **server host** whose recorded cwd is the
  project's workspace root (same directory after canonicalization), modified
  in the last 30 days, at most 200 candidates, newest first, with title, last
  activity, message count and whether it was already imported.
- `agentSessions.import { projectId, sessions: [{ provider, sessionId }] }`
  re-reads each file, creates thread `import:<instanceId>:<sessionId>` (a
  deterministic id makes repeats no-ops), appends up to 200 historical messages
  through a new server-internal command `thread.history.import` (one
  `thread.message-sent` per message, no turn), and writes a `suspended`
  `provider_session_runtime` row with the resume cursor so the next message
  resumes the CLI session. Parsing, skip rules and limits follow T3 Code's
  `AgentSessionScanner`/`AgentSessionImporter`; Claude ids must be UUIDs.
- Home resolution: Claude uses the instance `CLAUDE_CONFIG_DIR`, then the
  process env, then `~/.claude`; Codex uses the instance `homePath`, then
  `CODEX_HOME`, then `~/.codex`. Only the built-in/default instances of each
  driver are scanned.
- UI: project actions menu → **Import CLI sessions…** opens a dialog listing
  the candidates with checkboxes; importing lands on the newest imported
  thread. Scan uses `orchestration:read`, import uses `orchestration:operate`.

### 5. Closing a chat panel archives it

- Closing a chat panel interrupts its running turn (best effort) and archives
  the panel thread instead of deleting it; history and resume cursor remain.
- Other clients drop a tracked panel's tab when it leaves the live thread list.
- The chat header `+` menu gains **Reopen closed chat**, listing the host's
  archived panel threads (newest first, at most 10; a disabled item explains an
  empty list). Reopening reserves the tab, unarchives the thread, and every
  client adopts it again.
- Settings → Archived hides `kind: "panel"` threads.
- Deleting a thread also deletes panel threads whose `hostThreadId` is that
  thread, live or archived, in the same engine command.

## Out of scope

Resume across provider instances, model-generated summaries, importing
sessions for worktree paths other than the workspace root, and scanning
non-default provider instances.

## Validation

Each part ships with focused tests that fail without the change: supervisor
idle-deadline tests (busy while a subagent actor runs; suspended after it
completes; quiet cap), shutdown keeps a resumable row, per-provider fallback
tests plus handoff composition, scanner/importer fixture tests (Claude and
Codex JSONL), and web tests for panel archive/reopen. Gates: `cargo fmt`,
Clippy with warnings denied, `vp check`, `vp run typecheck`,
`vp run check:contracts`, and an end-to-end check on an isolated dev instance.
