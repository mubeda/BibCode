# Composer History

Status: Approved 2026-10-24 with every recommended answer. Design for issue 141, verified
against `4e023ac5ff` (v0.11.0).

## Problem

Continuing an earlier conversation means hunting for it. Closed chat panels sit
in the chat header's `+` menu. A Claude Code session started in a terminal in
the same folder can only come back through **Import CLI sessions…**, which
matches only the project root, creates a sidebar thread in `full-access` away
from the thread the user is in, and cannot tell that the terminal still has the
session open, so two processes then write one transcript.

## Current behavior

- **Composer footer.** The right group, `ComposerFooterPrimaryActions`
  (`apps/web/src/components/chat/ChatComposer.tsx:391`), holds Attach files
  (`:425-441`), MCP status, the context meter and send/stop. The approval
  footer is a separate branch (`:2716-2738`); the normal footer starts at
  `:2742` and renders the right group at `:2803`.
- **Reopen closed chat** lists the host's ten newest archived `kind: "panel"`
  threads from `useArchivedThreadSnapshots`, loaded only while the menu is open,
  with loading, empty and retry states
  (`apps/web/src/components/chat/ChatHeaderPanelMenu.tsx:44`, `:59-133`).
  Reopening reserves the tab and unarchives the thread
  (`apps/web/src/centerPanelActions.ts:148-172`).
- **Panels.** `worktree.createPanel` copies project, branch and worktree from
  the persisted host under the project mutation lock
  (`apps/server/src/production/worktree_catalog_rpc.rs:1385-1495`, the
  `ThreadCreate` at `:1467-1479`). Generic orchestration cannot nominate a
  workspace path or a host (`docs/architecture/worktree-catalog.md:269-283`,
  `apps/server/src/production/orchestration_rpc.rs:287-299`). The client
  creates panels in `DEFAULT_RUNTIME_MODE`, which is `full-access`
  (`centerPanelActions.ts:123`, `packages/contracts/src/orchestration.ts:125`).
- **Host validation is not atomic.** The engine's `ThreadCreate` checks the
  project but not `host_thread_id`
  (`apps/server/src/orchestration/engine.rs:3928-3976`).
  A generic `ThreadDelete` of a host takes no project lock; ingress refuses
  only adopted worktree owners (`orchestration_rpc.rs:310-323`). So
  `worktree.createPanel`'s revalidation under the lock can go stale before its
  dispatch, and the panel outlives its host. `ThreadDelete` cascades only to
  panels that exist when it is decided (`engine.rs:3997-4008`).
- **One provider conversation per thread.** `provider_session_runtime` and
  `projection_thread_sessions` are keyed by thread
  (`apps/server/src/persistence/migrations.rs:897`, `:966`); earlier session IDs
  survive in `provider_turn_outbox` (`:2174`).
- **Import scan.** Discovery stats every `*.jsonl` in every
  `<config dir>/projects/*` directory, up to 20,000 files
  (`apps/server/src/agent_sessions/mod.rs:262-322`), reads the first recorded
  cwd from the first 1 MiB (`:365-385`, matched at `:152`), then fully parses
  each match for its title and message count (`:160`, `:387-429`). Titles come
  from `aiTitle`, then the first prompt (`:459`, `:672-674`, `:809-821`);
  `custom-title` records are ignored. Every source is scanned, with no filter
  on how the session was started. `load`, which import uses to re-read one
  session, finds its file through the same global walk (`:194-236`), so a
  session in a directory sorted after 20,000 other files is not found.
- **Import result.** Thread `import:<instance>:<sessionId>`, `kind` none, no
  branch or worktree, `full-access`
  (`apps/server/src/production/agent_sessions_rpc.rs:42`, `:145-147`,
  `:452-470`), with a `suspended` runtime row whose cursor is
  `{"sessionId": id}` (`:539-605`). Sessions other BiBCode threads own are left
  out (`:151-170`; the owner query reads only `$.sessionId` and `$.threadId`,
  `apps/server/src/persistence/repositories.rs:376-394`). `ScanInput` and
  `ImportInput` accept unknown fields (`agent_sessions_rpc.rs:47-58`), so an
  older server ignores any field a newer client adds.
- **Claude launch.** `--resume <id>` when a cursor exists, else `--session-id`
  (`apps/server/src/production/provider_runtime.rs:14043-14047`). `spawn`
  drops a cursor whose transcript is missing (`:14325-14341`), launches the
  cursor's ID or a new UUID (`:14342-14346`), and sets
  `CLAUDE_CODE_ENTRYPOINT=sdk-rust` (`:14347-14350`). The started cursor is the
  ID it launched, reported without waiting for Claude (`:14762-14770`).
  `launch_session` treats a started ID that differs from the requested one as
  a lost resume and owes a context handoff (`:7298-7335`, `:7404-7406`).
- **Claude version.** The launch's activity probe runs `--version` and
  `--help` (`provider_runtime.rs:13921-13939`) and, when it has not finished,
  returns defaults (`:13811-13827`). The provider snapshot carries the
  installed `version` (`packages/contracts/src/server.ts:214`), which the
  server publishes as `PublishedProviderInventory`
  (`apps/server/src/production/control.rs:494-499`); `supports` and
  `semantic_version` compare versions
  (`apps/server/src/provider/claude/model.rs:108-125`).
- **Scopes.** Both RPCs need `orchestration:operate`
  (`apps/server/src/auth/scope.rs:82-85`). `AuthSessionState.scopes`, an
  optional key (`packages/contracts/src/auth.ts:383-389`), reaches the web for
  the primary environment through `usePrimarySessionState`
  (`apps/web/src/environments/primary/sessionState.ts:21`). Remote connections
  request `AuthStandardClientScopes`, which include operate
  (`apps/web/src/connection/platform.ts:469`), and keep no record of the scope
  granted. Without a scope list, a refusal arrives only as the RPC's
  authorization error (`apps/server/src/rpc/session.rs:1175-1200`).
- **Capabilities.** `ExecutionEnvironmentCapabilities` decode missing flags as
  `false` (`packages/contracts/src/environment.ts:30-84`); the server advertises
  them at `apps/server/src/production/control.rs:2579`.
- Nothing detects a session that is still open in a terminal.

## External behavior this depends on

From the Claude Code documentation on 2026-10-24 and the changelog through
2.1.310:

- `claude --resume <id>` works from any directory: Claude searches the current
  project and its worktrees, then every project; before 2.1.223 only the first
  ([CLI reference](https://code.claude.com/docs/en/cli-reference),
  [Manage sessions](https://code.claude.com/docs/en/sessions)).
- `--fork-session` creates a new session ID when resuming (CLI reference).
  Claude Code 2.0.73 "added support for custom session IDs when forking
  sessions with `--session-id`" combined with `--resume` and `--fork-session`
  ([changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)).
- Claude Code 2.1.239 fixed `/rename` titles vanishing from `/resume` once
  more than about 64 KB had been written after the rename (changelog). A
  transcript written before that version can hold its last `custom-title`
  outside the last 64 KiB.
- Resuming one session in two terminals without forking interleaves both
  writers' messages in one transcript (Manage sessions).
- A `--resume` of a background session that is still running, with flags that
  configure the session (BiBCode always passes `--permission-mode`,
  `--settings` and `--output-format`), sends nothing and exits with status 1;
  `--fork-session` resumes a copy (Manage sessions, v2.1.285 and later).
- The picker leaves out sessions created with `claude -p` or the Agent SDK.
- Transcripts live at `<config dir>/projects/<cwd with non-alphanumerics as
  ->/<id>.jsonl`; a name over 200 characters is truncated with a hash appended,
  so match its first 200 characters
  ([Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions)).
  `CLAUDE_CODE_PROJECT_DIR_NAME` (2.1.234 and later) can replace the name.
- `<config dir>/sessions/` "holds one small file per running session, used to
  detect concurrent sessions and crashes"; each is removed when its session
  exits and crash leftovers are cleared at the next launch. Fields are not
  documented ([.claude directory](https://code.claude.com/docs/en/claude-directory)).
- The transcript format is internal and changes between versions. The SDK's
  `customTitle` is the name the user set, "otherwise the AI-generated session
  title" ([TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)).

Observed on the design machine, in transcripts written by Claude Code 2.1.x
(evidence, not a contract):

- Records carry `entrypoint`: `cli` (terminal), `claude-desktop` (Desktop app),
  `sdk-cli` (`-p`), and `sdk-rust` (BiBCode's own launches). Of the 300 newest
  transcripts, 294 were `claude-desktop`, 4 `cli`, 2 `sdk-cli`.
- `custom-title` records (`type`, `customTitle`, `sessionId`) appeared in 294 of
  300; no record had `aiTitle`. The last `custom-title` record was always within
  32 KiB of the end of the file and the last `gitBranch` within 64 KiB.
  Transcript size: median 627 KB, 90th percentile 1.1 MB.
- `sessions/<pid>.json` holds `pid`, `sessionId`, `cwd`, `kind`, `entrypoint`,
  `status`, `procStart` and `updatedAt`, among others.

## Goals

- A **History** button in the composer opens a popover with this thread's
  closed chats and, below a separator, Claude Code terminal sessions run in
  this thread's folder.
- Choosing a terminal session continues it in a chat panel of this thread;
  the next message resumes the same session in the same folder.
- BiBCode never knowingly becomes a second writer of a live transcript.
- Opening the popover costs work proportional to this folder's sessions, not
  the machine's.

## Non-goals

Codex and OpenCode sessions; earlier provider conversations of the thread;
other worktrees of the repository; Desktop-app and IDE sessions; changing which
folders **Import CLI sessions…** matches; sessions moved with `/cd` or stored
under `CLAUDE_CODE_PROJECT_DIR_NAME`; stopping a terminal from resuming a
session after BiBCode took it over.

## Alternatives

**Where a chosen session lands** (the issue's table):

- **A. New chat panel of this thread.** Shares the worktree and branch, appears
  where the user clicked, archives on close, works under any host provider.
- **B. New sidebar thread**, as Import does today. Takes the user away, and the
  thread would have no worktree.
- **C. Replace this thread's provider conversation.** The visible transcript
  would disagree with what the agent knows.

**How the list is requested:**

- **Optional folder field on `agentSessions.scan`.** An older server ignores it
  and scans the project root, so the popover would show another folder's
  sessions as this one's. Rejected.
- **Client sends a path.** The client could name any folder on the server.
  Rejected.
- **New thread-keyed method; the server resolves the folder.** Chosen.

**Discovery:**

- **Today's walk plus full parse.** Up to 20,000 stats and a full read of every
  match: acceptable behind an explicit dialog, slow behind a toolbar button.
- **Targeted directories with head and tail reads.** Read only the names in
  `projects/`, keep the folder's encoded directory, read each transcript's head
  for cwd, entrypoint and first prompt and its last 64 KiB for title and
  branch, under one aggregate budget per request. `load` resolves a session in
  the same directories, so a listed session can always be opened. Chosen.
- **SDK `listSessions()`.** Needs a Node runtime in production, which
  `AGENTS.md` forbids. Rejected.

**Live detection:**

- **None.** Interleaved transcripts. Rejected.
- **Recent modification time.** Misses a terminal idle at its prompt and flags
  one just closed. Rejected.
- **`sessions/` entries with a live PID.** Best-effort and undocumented; when it
  cannot be read completely, assume live and fork. A resume Claude refuses
  anyway is recovered with a copy. Chosen.

**Fork identity:**

- **Let Claude choose the copy's ID.** `launch_session` would see a different
  started ID, record a lost resume and send a context handoff on top of a full
  copy. Rejected.
- **Server assigns the copy's UUID before launch** with `--session-id`, and
  copies are offered only on a Claude Code that honors it (2.0.73 and later).
  A copy that still starts under another ID fails its first turn and keeps its
  cursor; it is not continued under an ID BiBCode did not choose. Chosen.

## Decision

**A**, with new RPCs behind a capability, the existing scanner extended rather
than copied, server-assigned fork IDs, and a launch rule driven by which
transcript exists.

1. Capability `cliSessionHistory`, and two operate-scoped RPCs:
   `agentSessions.listForThread` and `agentSessions.openInPanel`.
2. The scanner gains a metadata mode: targeted discovery shared with `load`,
   head and tail reads under one aggregate budget, the interactive filter,
   `custom-title` titles with a fallback for buried ones, branch, and
   liveness.
3. `openInPanel` creates a panel the way `worktree.createPanel` does, but under
   the import's deterministic thread ID, in the host's runtime mode, with the
   session's history and a suspended runtime row.
4. **Continue** resumes the session; **Continue in a copy** forks it under a
   UUID BiBCode derives, recorded before launch, so no handoff is sent.
5. The engine's `ThreadCreate` validates a panel's host, so the engine orders
   a panel's creation against its host's deletion. A lock cannot do this,
   because deletion takes none.

What this trades away: Desktop-app sessions are not listed; liveness is
best-effort; after BiBCode resumes a closed session, a terminal can still
resume it and interleave; each **Continue in a copy** makes another copy;
copies need Claude Code 2.0.73 or later.

Further decisions:

- **Interactive filter.** List a session whose first `entrypoint` is `cli` or
  absent (older versions). `sdk-*` (including BiBCode's `sdk-rust`, a second
  guard beside the owner query, because deleting a thread deletes its runtime
  row, `apps/server/src/orchestration/engine.rs:5838-5843`) and
  `claude-desktop` are left out; the Desktop app keeps its own session list.
- **Title tiers.** The issue's "name you set, then generated title" is one tier
  on disk: Claude writes both as `customTitle` and the file cannot tell them
  apart. Order: last `customTitle`, then last `aiTitle` (older versions), then
  the first prompt line (100 characters), then "Untitled session". "Last"
  holds even when the record sits between the head and the tail windows
  (step 6 of `listForThread`).
- **Copies are independent.** A copy's panel is titled "<title> (copy)". The
  source row does not link to its copies.
- **Open across threads.** An imported session whose thread is this host's
  panel reopens or activates it; one that is another host's panel or a sidebar
  thread navigates there (and activates the panel).

## Answers to the open questions

1. **Earlier provider conversations in This thread?** No. Their messages are
   already in the thread, so choosing one has no clear meaning.
2. **Codex in v1?** No. The section is per provider, so a Codex section can
   follow under its own separator.
3. **Other worktrees of the repository?** No. Matches Claude's default picker
   scope, the current worktree.
4. **Should Import CLI sessions… match worktree folders?** No, which departs
   from the issue's default. The dialog creates ordinary threads with no
   worktree, so a worktree session imported there would continue in the
   project root's checkout, a different set of files, and only the worktree
   catalog may nominate a workspace path (`worktree-catalog.md:269-283`).
   History inside the worktree's thread is where those sessions belong. The
   dialog's note becomes "Sessions run in a worktree are in that worktree
   thread's History." The dialog still gains the `custom-title` fix, because it
   shares the scanner.

## Protocol and schema

`packages/contracts/src/agentSessions.ts`:

```ts
AgentSessionThreadListInput = { threadId: ThreadId };
AgentSessionLiveness = Literals(["closed", "live", "unknown"]);
AgentSessionHistoryEntry = {
  sessionId: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  lastActiveAt: IsoDateTime,
  branch: NullOr(TrimmedNonEmptyString),
  liveness: AgentSessionLiveness,
  // A live import whose history committed. resumeRefused: Claude refused its
  // resume (see "Resume refused"), so the row offers a copy instead of Open.
  importedThread: optionalKey({
    threadId,
    hostThreadId: NullOr(ThreadId),
    archived: Boolean,
    resumeRefused: Boolean,
  }),
  // The import's thread was deleted; only a copy is possible.
  importDeleted: Boolean,
};
AgentSessionThreadListResult = {
  sessions: Array(AgentSessionHistoryEntry),
  truncated: Boolean,
  // Claude Code honors --session-id with --fork-session (2.0.73+).
  copySupported: Boolean,
};
AgentSessionOpenInPanelInput = {
  commandId: CommandId,
  hostThreadId: ThreadId,
  sessionId: TrimmedNonEmptyString,
  mode: Literals(["resume", "fork"]),
};
AgentSessionOpenInPanelResult = {
  threadId: ThreadId,
  hostThreadId: NullOr(ThreadId),
  outcome: Literals(["created", "existing"]),
};
```

`AgentSessionCandidate`, the Import dialog's row, gains an optional
`hostThreadId`: a session continued from History is a panel thread, so the
dialog's **Open** navigates to its host and activates the panel instead of
opening a hidden thread. Older clients ignore the field.

Errors stay `AgentSessionsError | EnvironmentRpcError`. `rpc.ts` adds the two
methods to `WS_METHODS` and `WsRpcGroup`; `environment.ts` adds
`cliSessionHistory` (decoding default `false`), advertised `true` in
`control.rs`. `methods.rs` lists `read_unary("agentSessions.listForThread")`
and `mutation_unary("agentSessions.openInPanel")`; `scope.rs` puts both under
operate.

### `agentSessions.listForThread`

1. Read the thread (live). Its host is itself, or its `host_thread_id` for a
   panel. The folder is the host's `worktree_path`, else the project's
   workspace root, canonicalized as `canonical_workspace_root` does
   (`agent_sessions_rpc.rs:237-240`).
2. The source is the built-in `claudeAgent` instance from `resolve_sources`
   (`:196-235`). When it is off: `AgentSessionsError` "Claude Code is turned off
   on the server. Turn it on in Settings → Providers."
3. **Folder directories**, one resolver shared with `load`: read the entry
   names of `<config dir>/projects/` and keep
   `claude_project_directory_name(folder)`, the same for its canonical path,
   and, when the encoded name exceeds 200 characters, names starting with its
   first 200 (`apps/server/src/provider/environment.rs:42-62` gains a prefix
   variant). Listing stats `*.jsonl` only there, within the existing 30-day
   window.
4. **Aggregate budget.** One request opens at most 1,000 transcripts and reads
   at most 64 MiB across every head, tail and title read below. Running out
   ends the listing with `truncated`. Before opening a file, its stem (the
   session ID for Claude) must be a resumable UUID, not owned by another
   thread and not seen already, so those cost a `stat` only.
5. Newest first, until 200 candidates or the budget runs out: the head read
   (existing 1 MiB and 1,000 record bounds) takes the first cwd, which must
   match as today, and the first `entrypoint`; it stops at the first record
   that excludes the session (a non-matching cwd or an `sdk-*` or
   `claude-desktop` entrypoint), and otherwise at the first visible user
   prompt under the existing skip rules, taking any title on the way. The
   tail read (last 64 KiB, first partial line dropped) takes the last
   `customTitle`, `aiTitle` and `gitBranch`; a tail value beats a head value.
   No full parse and no message count.
6. **Title fallback.** When the tail holds no `customTitle` or `aiTitle`, the
   reader walks back from the tail toward the head window in 256 KiB chunks,
   searching the raw bytes for `custom-title` and `aiTitle` and parsing only
   the line that holds the last match. The walk counts against the budget, and
   at most 16 MiB of the budget goes to it; once that is spent, the remaining
   rows fall back to their head title or first prompt and are not dropped. On
   the design machine every last title sat in the tail, so the walk is the
   exception, kept for transcripts written before Claude Code 2.1.239.
7. Liveness reads `<config dir>/sessions/*.json` once per request (at most 256
   files of at most 64 KiB, `sessionId`, `pid` and `entrypoint` only). A file
   naming the session whose PID is alive makes it `live`. The enumeration
   counts only when it is complete: a directory that cannot be read, more
   than 256 entries, or one file that cannot be read or parsed, or exceeds
   64 KiB, makes every session not already found `live` read `unknown`.
   Otherwise the session is `closed`. An entry whose `entrypoint` is
   `sdk-rust` is BiBCode's own process and is skipped, if BiBCode's processes
   write entries at all (checked with the directory question below). A
   missing directory is `unknown` only if Claude Code keeps the directory once
   its last session exits (then absence means a version that does not write
   it); if Claude removes it, absence beside a readable `projects/` is
   `closed`. This is checked before implementation (see Verification),
   because otherwise **Continue** would never be offered on a host with no
   running session. PID liveness is a new cross-platform helper on the
   existing `sysinfo` dependency (the `process_alive` in
   `device/android/testing.rs:1025` is test-only and Unix-only). `procStart`
   is undocumented and not parsed, so a reused PID reads as live, which only
   forces a copy.
8. Import state as the scan computes it today (`:250-300`), extended with the
   thread's kind, host and archive state, and `resumeRefused` from the import
   runtime row's payload (see "Resume refused").
9. `copySupported` is `supports(semantic_version(version), [2, 0, 73])` over
   the `claudeAgent` entry of `PublishedProviderInventory`; an unknown version
   is `false`. The handler's services gain the inventory handle, which
   `runtime.rs` already passes to launches.

The read runs in `spawn_blocking` and honors the request's cancellation token,
as `scan` does (`:268-281`).

### `agentSessions.openInPanel`

1. Read the host (live) and resolve the folder as `listForThread` does. For
   `fork`, refuse when `copySupported` is false: "Continue in a copy needs
   Claude Code 2.0.73 or later. Update it in Settings → Providers."
2. Thread ID: `import:claudeAgent:<sessionId>` to resume;
   `copy:claudeAgent:<forkId>` to fork, where `forkId` is the first 16 bytes
   of SHA-256 over a fixed domain string, `commandId` and `sessionId`, through
   `uuid::Builder::from_random_bytes` (UUID v4 layout, no new crate feature).
   A retry with the same command ID reaches the same thread. The copy's ID is
   deliberately not an import ID: once the copy's transcript exists in the
   folder's directory, the owner query pairs `forkId` with a thread that
   `is_import_of` (`agent_sessions_rpc.rs:165-170`) rejects, so the existing
   owner filter drops the copy from History and from the Import dialog as a
   conversation BiBCode owns. Only `:146` and `:167` read the prefix.
3. A thread with that ID whose history committed returns `existing`; one in
   another project is refused as today. A thread with that ID of another kind
   or host, such as an interrupted sidebar import, finishes its own import and
   returns `existing` with its own host (`null` for a sidebar thread), never a
   panel of this host. A deleted resume thread is refused: "This session's chat
   was deleted. Choose Continue in a copy." That refusal does not reach
   copies. Each **Continue in a copy** sends a new command ID, so its `forkId`
   and thread are new and never meet a deleted copy. Only a retry of the same
   command could, and it is refused like any replay of a deleted thread.
4. Re-read the session with `load` (folder match, at most 200 messages) and
   apply the listing's filters. `load` resolves the file through the folder
   resolver of `listForThread` step 3, building
   `<directory>/<sessionId>.jsonl` directly instead of walking every project,
   so unrelated projects cannot exhaust a budget before it reaches the
   session. When no folder directory holds the file, `load` falls back to
   today's walk, which keeps the Import dialog's cwd-matched sessions stored
   under another directory name openable. For `resume`, check liveness again;
   `live` or `unknown` is refused: "This session is open in a terminal. Choose
   Continue in a copy." This read takes no lock.
5. Under the host project's mutation lock, as `create_worktree_panel` does:
   re-read the host (live, same project) and require the folder resolved in
   the first step. The folder check guards a worktree change, which the
   catalog makes under this lock: "This thread's folder changed. Try again."
   It does not guard a deletion, because a generic `ThreadDelete` takes no
   lock.
6. Still under the lock, dispatch `ThreadCreate` with `kind: "panel"`, the
   host's ID, branch and worktree, the host's `runtime_mode`, interaction mode
   `default`, the model from `import_model_selection`, and the session's title
   ("<title> (copy)" for a fork), as `<threadId>:create`.
7. Insert the suspended runtime row in the host's runtime mode with cursor
   `{"sessionId": id}`, or `{"sessionId": forkId, "forkedFrom": sessionId}`.
   `insert_provider_session_runtime_if_absent_for_live_thread` already refuses
   a deleted thread.
8. Dispatch `thread.history.import` as `<threadId>:history`.

Steps 3 and 6-8 share `import_session` (`:388-494`) through a target parameter
(sidebar or panel of a host) instead of a copy.

**Host validation at commit.** The engine's `ThreadCreate` decision
(`engine.rs:3928`) gains the panel invariant: when `host_thread_id` is set,
the host must exist in the command model, not be deleted, belong to the same
project and not be a panel itself. The engine decides commands one at a time,
so this check and `ThreadDelete`'s cascade are ordered. If the host's deletion
is decided first, the panel's creation is refused ("The thread was deleted.")
and nothing further runs. If the panel is created first, the deletion's cascade
finds it and deletes it with the host. This also closes
`worktree.createPanel`'s window between its revalidation and its dispatch.
Generic clients are unaffected, because they cannot send `host_thread_id`
(`orchestration_rpc.rs:287-299`).

### The fork launch

In `ClaudeDriver::spawn` (`provider_runtime.rs:14325-14346`), the launch is
decided by which transcript exists, with the rules tried in this order:

- **Fork** when the cursor has `forkedFrom`, the copy's transcript is not known
  to exist, and the source's is not known to be missing:
  `--resume <source> --fork-session --session-id <forkId>`. The started cursor
  is the requested one, `forkedFrom` included, so a crash before Claude writes
  the copy forks again instead of starting empty.
- **Resume** when the cursor's own transcript exists, or cannot be checked and
  the cursor has no `forkedFrom`: `--resume <id>`. Every launch after the
  copy's first turn takes this path.
- **New** otherwise, as today, which records the lost resume and sends the
  handoff.

Because the started ID equals the requested one, `launch_session` records no
lost resume (`:7298-7335`).

**Version gate.** `ClaudeActivitySupport`, the probe result, gains
`fork_session_id`: the probed version is 2.0.73 or later and `--help` lists
`--fork-session`. Both come from the two commands the probe already runs. A
fork launch requires it:

- When the probe finished and says no, `spawn` fails with "Continue in a copy
  needs Claude Code 2.0.73 or later. Update it in Settings → Providers, then
  send again."
- When the probe has not finished by the launch deadline, it returns defaults
  today. A fork launch then fails with "BiBCode is still checking the Claude
  Code version. Send again." instead of guessing. The probe keeps its own
  deadline contract.
- Both errors keep the requested cursor, as the launch error path already
  does (`:7280-7293`), so the next send forks.

`listForThread` and `openInPanel` apply the same minimum through
`copySupported`, so an older Claude is caught before a panel exists. The
launch gate covers a binary changed after the open.

**ID check.** This is a backstop for a Claude that passes the gate but still
picks its own ID. In stream-json mode Claude reports the session ID in the
first turn's `system/init`, after the message is written. Nothing earlier is
known to carry it, so `start` cannot wait for it; the Verification section
checks whether the `initialize` control response names the session, and if it
does, the check moves there, before any message is sent. In fork mode, the
Claude runtime compares the init's `session_id` with the assigned ID before
forwarding any output of the turn. On a mismatch it:

- interrupts the turn and stops the process;
- fails the turn with "Claude Code continued the copy under another session
  ID. Update Claude Code, then send again.";
- keeps the requested cursor, `forkedFrom` included;
- logs `tracing::warn!` without content.

The panel shows no answer for that turn, so the visible transcript and the
agent's knowledge agree, and the retry forks the unchanged source again. The
stray transcript Claude wrote stays on disk; see Risks.

**Resume refused.** A `--resume` launch (not a fork) of an imported session's
own ID, that is `is_import_of(thread_id, sessionId)`, whose transcript exists
and whose process exits with a non-zero status before its first `system/init`
does two things:

- fails the turn with "Claude Code couldn't continue this session here. It may
  still be running in a terminal or in the background. Choose Continue in a
  copy in History.";
- writes `"resumeRefused": true` into the runtime row's payload.

The next `system/init` of that session clears the flag. The cause is not
classified, because Claude's message is not a contract. A copy is safe
whatever the cause, so the flag only changes which action History offers.
Native threads and copies, which History never lists, keep today's error on
an early exit, so expired sign-in or broken settings never point them at
History.

## Persistence

No migration. Claude cursors in `provider_session_runtime.resume_cursor_json`
gain an optional `forkedFrom`, and the runtime payload JSON an optional
`resumeRefused`. The owner query reads `$.sessionId`, so a copy
belongs to its panel and the source stays the terminal's. An older server
reading such a row finds no transcript for the copy's ID before its first turn
and starts a new conversation with a handoff: degraded, not corrupt. Panel
threads are ordinary panels: archived on close, deleted with their host.

## Trust boundaries

- Both methods need operate, because titles are first prompts from
  transcripts outside BiBCode's data.
- The server resolves the folder from the thread row; the client names no path
  or config directory. `sessionId` must be a resumable UUID before any path is
  built; the fork ID is server-derived.
- Reads stay under the `claudeAgent` instance's config directory, with the
  existing size bounds and a cap on `sessions/` files.
- The panel runs in the host's runtime mode, never broader. BiBCode passes
  `--permission-mode`, so the mode Claude would restore on resume does not
  apply.
- Logs, profiler records and errors carry session IDs and counts only: no
  titles, prompts, branch names or paths. Error texts are fixed strings.
- One server is one host: a remote environment reads only its own
  `<config dir>`, and nothing crosses hosts.

## Failure, cancellation, reconnect and concurrency

- Closing the popover aborts the list request; the server's token stops the
  scan between files and inside the record reader. Closing does not cancel an
  `openInPanel` in flight; its tab opens when it finishes.
- A disconnect during the list shows the error state with retry. A retried
  open reuses its command ID, so it returns the same thread.
- Two clients resuming one session reach the same thread ID; command admission
  lets one create it and the other gets `existing`. Two copies are two explicit
  actions with different command IDs.
- Liveness is checked again at open. A terminal that resumes the session
  between the open and the panel's first turn is not detected; that window, and
  any later terminal resume, is the ownership risk below.
- A transcript removed between list and open fails with the existing "not
  found" reason; the list refreshes.
- A host deleted while the transcript loads, or at any point before the panel
  is created, makes the engine refuse the panel's `ThreadCreate`; a host
  deleted after it deletes the panel with it. No path leaves a panel without
  its host.
- A resume Claude refuses, such as a running background session with no
  `sessions/` entry, fails the panel's first turn, and History then offers
  **Continue in a copy** for that session.

## Performance

- Web: nothing loads until the popover opens; one request per open; no
  polling.
- Server: one `readdir` of `projects/` (names only), stats only in the
  folder's directories, and per opened transcript a head read that stops at
  the first excluding record or the first user prompt, plus a 64 KiB tail read
  for those that pass. This replaces today's full parse of every match (median
  transcript 627 KB above). The bound counts what is inspected, not what is
  returned: at most 1,000 transcripts opened and 64 MiB read per request,
  title fallback included, whatever share of the folder is Desktop, SDK,
  owned or duplicate sessions. Owned, duplicate and non-UUID files are
  rejected by name before they are opened. The `sessions/` read is at most 256
  files of 64 KiB. Measure the popover's scan before merging on a folder with
  200 terminal sessions and on one with 1,000 Desktop sessions and 5 terminal
  sessions.
- `openInPanel` reads one transcript in full under the existing bounds, as
  import does.
- React: the popover's sections mount only while open and keep their own
  state, so a list result does not re-render the composer. The menu is passed
  to the footer as a slot element memoized in `ChatView`, so the memoized
  footer keeps its props stable.

## Profiler coverage

- **RPC methods:** both register through `registry.register_unary`, which the
  `rpc/session.rs` wrappers time, and appear in `rpc/methods.rs` and
  `auth/scope.rs`. `openInPanel` joins `is_long_running`
  (`apps/server/src/diagnostics/profiler/latency.rs:148`) beside
  `agentSessions.import`: it reads a whole transcript and waits on the project
  lock. `listForThread` stays out. Its aggregate budget (1,000 opens, 64 MiB,
  one `sessions/` read) is what bounds it, not the number of rows returned, so
  a call over `rpc.slow`'s 1 s (`:41`) means the budget is wrong or the disk is
  slow, and either is worth a finding. If the pre-merge measurement exceeds
  1 s on the Desktop-heavy folder, the budget is lowered; the method is not
  added to the list.
- **Child processes:** none new. The fork launch is an ordinary Claude driver
  spawn, already supervised, attributed and exit-reported. A fork-ID mismatch
  stops the process through the driver's ordinary shutdown, so its exit is
  requested and raises no `subprocess.crash`. A refused resume is an
  unrequested exit and is reported as today.
- **Logs:** `tracing::warn!` when `sessions/` cannot be read completely, on a
  fork-ID mismatch and on a refused resume, with session IDs and counts only.
- Worktree removal, binaries, shutdown, and new events or findings: none.

## UI

**Button.** A ghost `icon-sm` button with lucide `HistoryIcon`, aria-label and
tooltip **History**, first in `ComposerFooterPrimaryActions`, before Attach
files. Not rendered in the approval footer. Disabled, with the reason in its
tooltip, when the thread has not started ("Available once this thread has
started."), the environment is not connected ("<label> is not connected"), the
workspace is unavailable (the existing reason), or the connection lacks
operate access ("This connection can only view threads."). In a panel's
composer it acts for the host thread.

**Operate access.** For the primary environment, the button reads
`usePrimarySessionState().data?.scopes` and is disabled only when that list is
present and lacks `orchestration:operate`. An absent list (an older server, a
pending or failed read) leaves the button enabled, and a refusal shows in the
section as before. Remote environments have no scope list on the client in
v1: they request `AuthStandardClientScopes`, which include operate, and keep
no record of what was granted, so a remote connection narrowed by its pairing
link still sees the refusal in the section. The token response already
carries the granted `scope`; recording it on the connection is the follow-up
that would disable the button there too.

**Popover.** Built on the `Menu` primitives the `+` menu uses, for arrow-key
navigation, Escape and focus return. Two labeled groups, newest first:

1. **This thread**: the same closed panels as **Reopen closed chat**, from one
   hook extracted from `ChatHeaderPanelMenu.tsx:59-133`. Each row: title and
   relative time; choosing one reopens it as the active tab. Empty: **No closed
   chats**.
2. A separator.
3. **Claude Code terminal**: title and relative time; a second line with the
   branch, **Open in a terminal** when live (**Can't tell whether it's open**
   when unknown, **Couldn't continue it here** when its resume was refused),
   and the action the click takes: **Continue** (closed), **Continue in a
   copy** (live, unknown, a deleted import, or an import whose resume was
   refused), **Open** (already imported). When a row would offer **Continue
   in a copy** but `copySupported` is false, the row is disabled and its
   second line reads "Update Claude Code to continue this in a copy." States:
   **Loading…**; **No Claude Code sessions in this folder**; **Couldn't load
   sessions. Select to retry.** with the server's reason beneath (operate
   refusal, Claude turned off). An older server shows "Update <label> to list
   its terminal sessions here." When the environment is not this desktop's
   own, the empty state adds "Only sessions run on <label> appear here." A
   truncated list ends with "Older sessions aren't shown."

**After a choice.** The row shows **Opening…** and the menu stays open; on
success it closes and the panel becomes the active tab. A failure shows a toast,
"Couldn't open the session", with the reason, and the list reloads, so a
session that went live now offers **Continue in a copy**. A refused resume
shows its fixed text in the panel's failed turn, and the same session's
History row then offers **Continue in a copy**.

Against `UI.md`: one action per row, named on the row, matches the mental model
of "continue where I left off" without a choice the user must understand; the
default is the safe one (a copy whenever ownership is unclear); disabled states
and errors say why and what to do; nothing destructive, so no confirmations.
The approval footer stays uncluttered. Text uses `text-xs` and solid
`text-muted-foreground` for secondary lines.

**Gap:** on a remote environment narrowed to read access, and on a primary
environment whose server sends no scope list, the button stays enabled and the
section shows the refusal (see Operate access).

## Files to change

- `packages/contracts/src/agentSessions.ts`, `rpc.ts`, `environment.ts`, and
  the regenerated `packages/contracts/fixtures`.
- `packages/client-runtime/src/state/projectCommands.ts`: two commands.
- `apps/server/src/agent_sessions/mod.rs`: metadata mode, the folder
  resolver shared by listing and `load`, the aggregate budget, tail read and
  title fallback, entrypoint, `custom-title`, branch, liveness; `tests.rs`.
- `apps/server/src/production/agent_sessions_rpc.rs`: the two handlers, the
  shared import target, `copySupported`, and services that gain the worktree
  catalog (for the project lock) and the provider inventory;
  `production/runtime.rs` passes both.
- `apps/server/src/orchestration/engine.rs`: the panel-host invariant in the
  `ThreadCreate` decision.
- `apps/server/src/provider/environment.rs`: prefix variant of the directory
  name.
- `apps/server/src/production/provider_runtime.rs`: the fork launch rule and
  its arguments, `fork_session_id` in the probe result, the version gate, and
  the refused-resume marker.
- `apps/server/src/provider/claude/runtime.rs`: the init session-ID check and
  the stop on a mismatch.
- `apps/server/src/provider/claude/model.rs`: `supports` and
  `semantic_version` become crate-visible.
- A small PID-liveness helper beside the server's process utilities.
- `apps/server/src/rpc/methods.rs`, `auth/scope.rs`,
  `diagnostics/profiler/latency.rs`, `production/control.rs`.
- `apps/web/src/components/chat/ComposerHistoryMenu.tsx` (new) and its test;
  `ChatComposer.tsx` (slot); `ChatView.tsx` (renders it);
  `ChatHeaderPanelMenu.tsx` and `.logic.ts` (shared closed-chat hook);
  `apps/web/src/centerPanelActions.ts` (`openSessionPanel`);
  `ImportCliSessionsDialog.tsx` (worktree note, **Open** for a panel import);
  the composer's disabled reason reads `usePrimarySessionState`.
- `apps/server/tests/production_agent_sessions_rpc.rs`.
- Living docs, below.

## Test plan

Each test is written first and fails on `4e023ac5ff`.

Scanner (`apps/server/src/agent_sessions/tests.rs`):

- A session in the worktree's encoded directory is listed; one in the project
  root, a subfolder or a sibling worktree is not.
- A folder whose encoded name exceeds 200 characters matches its hashed
  directory by prefix.
- `entrypoint` `sdk-cli`, `sdk-rust` and `claude-desktop` are left out; `cli`
  and absent are listed.
- Title: a late `custom-title` beats an early one and `aiTitle`; without either,
  the first prompt line.
- Title fallback: a 3 MiB fixture whose last `custom-title` sits 1 MiB before
  the end, outside both the head and the tail windows, lists that title; with
  the fallback share of the budget spent, the row keeps its first prompt line
  and is still listed.
- Branch is the last `gitBranch`; a transcript larger than the head and tail
  bounds yields metadata without a title walk or a full read when the tail
  holds the title.
- Budget: a folder of 1,500 `claude-desktop` transcripts and 3 `cli` ones,
  oldest, stops after 1,000 opens with `truncated`; owned and duplicate
  session files are rejected without being opened (a test reader counts
  opens); an excluded transcript's head read stops at its first record.
- Liveness: a `sessions/` entry with a live PID is `live`, one with a dead PID
  is `closed`, a missing or unparsable directory is `unknown`; 257 entries, or
  one oversized or unparsable entry among readable ones, make every session not
  found live `unknown`.
- `load` finds a session in the folder's directory when 20,001 transcripts in
  directories sorted before it would exhaust today's walk; a session the
  folder's directories do not hold is still found by the walk.
- Cancellation before the first file returns nothing.

RPC (`apps/server/tests/production_agent_sessions_rpc.rs`):

- `listForThread` from a panel lists the host's folder; an imported session
  reports its thread, host and archive state; a deleted import reports
  `importDeleted`.
- `openInPanel` resume creates a panel of the host with the host's branch,
  worktree and runtime mode, at most 200 messages, and a cursor whose next
  launch passes `--resume <id>` in the worktree.
- Resume of a live or unknown session is refused; fork of the same succeeds
  and leaves the source transcript unchanged.
- The same command ID twice returns one thread; two clients resuming one
  session get one thread.
- Host deleted mid-open: with `load` blocked on a test gate, a generic
  `ThreadDelete` of the host is dispatched and accepted; once `load` is
  released, `openInPanel` is refused and no panel thread or runtime row
  exists. The same order for `worktree.createPanel`, gated before its
  dispatch, is refused too. A host deleted after the panel's creation deletes
  the panel.
- `listForThread` reports `copySupported: false` for an inventory version of
  2.0.72 or none; `openInPanel` in fork mode is then refused.
- An import whose runtime payload carries `resumeRefused` reports it in
  `importedThread`.
- After a copy's first turn writes `<forkId>.jsonl` into the folder's
  directory, with a first record whose `entrypoint` is `cli`, neither
  `listForThread` nor the Import dialog's scan lists the copy; the source is
  still listed.
- A read-only credential is refused for both methods.

Engine (`apps/server/src/orchestration/engine.rs` tests): `ThreadCreate` with
a `host_thread_id` that is missing, deleted, in another project or itself a
panel is refused.

Launch (`provider_runtime.rs` tests, beside
`claude_resumes_only_a_conversation_whose_transcript_exists` at `:18347`):

- First launch of a fork cursor passes `--resume <source> --fork-session
  --session-id <fork>` and records no context handoff.
- Second launch, once the copy's transcript exists, passes `--resume <fork>`
  and no `--fork-session`.
- A fork whose source transcript is gone starts new and owes the handoff.
- A fork launch with a probe reporting 2.0.72, or no finished probe, fails
  with its fixed text and keeps the cursor `{sessionId: fork, forkedFrom}`.
- A fixture whose `system/init` names another session ID fails the fork's
  first turn before any assistant output reaches the thread, stops the
  process, and keeps the fork cursor; the next launch forks again.
- A fixture that exits 1 before `system/init` on `--resume` of an `import:`
  thread fails the turn with the refused-resume text and sets
  `resumeRefused`; a later successful init clears it. The same exit on a
  native thread keeps today's error and sets nothing.

Contracts: `check:contracts` regenerates fixtures, `rpcRustParity.test.ts`
lists both methods, and the capability decodes `false` when absent.

Web (`ComposerHistoryMenu.test.tsx`, `ChatHeaderPanelMenu.test.tsx`):

- Both sections render in order with their empty, loading and retry states;
  the remote and older-server texts appear.
- This thread lists exactly the panels **Reopen closed chat** lists.
- Closing the menu aborts the list request.
- Each row state picks its action and sends `resume` or `fork`, including a
  refused import, which sends `fork`; a copy row with `copySupported: false`
  is disabled with its update text; success activates the panel tab; failure
  toasts and reloads.
- Disabled reasons for not started, not connected, unavailable workspace, and
  a primary session whose scope list lacks operate; an absent scope list
  leaves the button enabled; hidden in the approval footer.
- The Import dialog's **Open** on a panel import navigates to its host and
  activates the panel.

## Verification

- Gates: focused Rust and web tests, `vp run check:contracts`, `vp check`,
  `vp run typecheck`, `cargo fmt --all --check`, Clippy with warnings denied;
  the `UI.md` and `vercel-react-best-practices` reviews of the menu and the
  composer change.
- Before implementing liveness: with no Claude Code session running, check
  whether `<config dir>/sessions/` still exists (macOS, Linux, Windows). The
  answer fixes how a missing directory reads (`listForThread`, step 7). In
  the same check, run a BiBCode Claude panel and see whether its `--print`
  process writes an entry, and with which `entrypoint`.
- Before implementing the ID check: see whether Claude's `initialize` control
  response, or any message before the first turn, names the session ID. If one
  does, the check runs there, before a message is written.
- Manual, on macOS and one remote environment: run `claude` in a worktree,
  exit, **Continue** in History, send a message, then check in a terminal that
  `claude --resume <id>` shows that turn; with `claude` still open,
  **Continue in a copy**, send, and check the terminal's conversation has no
  BiBCode turn; on the remote, check the empty-state text.
- Living documents: `docs/user/workspace-ui.md` (Importing CLI sessions, the
  Center Panel paragraph, a History paragraph); `docs/providers/claude.md`
  (terminal sessions, resume and copy); `docs/architecture/providers.md`
  (Imported CLI sessions and the launch rule, the `forkedFrom` cursor, the
  version gate, `resumeRefused`); `docs/architecture/rpc-and-orchestration.md`
  (CLI session import and the long-running list);
  `docs/architecture/worktree-catalog.md` (the panel-host invariant that
  `ThreadCreate` now enforces); `docs/testing/cross-platform-validation.md`
  (the steps above, beside the chat panel checks).

## Rollout

One PR, in commits: scanner and contracts; server RPCs and launch rule; web.
A client shows the terminal section only when the server advertises
`cliSessionHistory`; This thread works against any server. No migration and no
setting. A downgraded server keeps imported panels; an unstarted copy becomes a
new conversation with a handoff.

## Risks

- **Undocumented formats.** `entrypoint`, `custom-title`, `gitBranch`, the tail
  position of metadata, and `sessions/` can change in any Claude release. Each
  failure mode is safe: a session missing from the list, a plainer title, or
  `unknown` liveness, which forces a copy.
- **Liveness that reads `unknown` too often** turns every row into **Continue
  in a copy**, and the session the user wanted continued is never continued.
  The pre-implementation check above decides the missing-directory case; an
  unreadable or incomplete directory still forces copies.
- **Ownership after resume.** Nothing stops a later `claude --resume` in a
  terminal while the panel lives; both write one transcript.
- **Background sessions.** A running background session may have no
  `sessions/` entry. Resuming it costs the panel's first turn, which fails
  with the refused-resume text; History then offers **Continue in a copy**.
- **A copy that starts under another ID.** The version gate keeps Claude
  older than 2.0.73 from being asked. If a newer one still picks its own ID,
  that first turn fails and is retried as a fresh fork. The stray transcript
  Claude wrote under its own ID stays on disk, and no BiBCode thread names
  it, so the owner filter cannot hide it. It may be listed as a second
  session with the source's title if its first record keeps the source's
  `cli` entrypoint. A successful copy is not affected: its `copy:` thread
  owns its ID (`openInPanel`, step 2).
- **Nearly empty list for Desktop-app users,** by the entrypoint decision.
- **Remote read-only clients** see an enabled button whose section explains
  the refusal, until the remote connection records its granted scope.
- **A budget-truncated listing** can omit an older terminal session in a
  folder crowded with Desktop sessions; the list says older sessions aren't
  shown, and **Import CLI sessions…** still finds root-folder ones.

## Review

Codex reviewed the proposal read-only. Each finding was checked against the
code at `4e023ac5ff` before it was dispositioned.

1. **Host deleted while the transcript loads leaves an orphan panel.**
   Accepted. A generic `ThreadDelete` takes no project lock
   (`orchestration_rpc.rs:310-323`), and `ThreadCreate` checks the project
   only (`engine.rs:3928-3976`). The engine's `ThreadCreate` now validates the
   host, which orders creation and deletion. The transcript load moves outside
   the lock, the lock's folder check guards worktree changes only, and a test
   deletes the host while `load` is blocked. The same fix closes the window in
   `worktree.createPanel`.
2. **A fork-ID mismatch only logs, and the copy loses its first turn.**
   Accepted. Copies are offered only when the provider inventory's version is
   2.0.73 or later (`copySupported`), and a fork launch requires the probe's
   `fork_session_id`. An unfinished probe is a retryable error. A mismatch
   fails the turn before any output, stops the process and keeps the fork
   cursor. Claude reports the ID only in the first turn's `system/init`
   (`start` reports it without waiting, `provider_runtime.rs:14762-14770`),
   so the check cannot run before the message is written unless `initialize`
   carries the ID, which Verification checks.
3. **Incomplete liveness can choose resume, and a refused resume leaves only
   Open.** Accepted. A capped, unreadable or oversized `sessions/` enumeration
   now reads `unknown`. A `--resume` that exits non-zero before `system/init`
   marks `resumeRefused`, and History offers **Continue in a copy** for that
   import.
4. **`load` uses global discovery, so a listed session may not open.**
   Accepted (`agent_sessions/mod.rs:194-236`). `load` builds the path through
   the listing's folder resolver and walks only when no folder directory holds
   the file, which keeps the Import dialog working. A test exhausts today's
   budget with unrelated projects.
5. **Head and tail sampling misses a rename buried mid-file.** Accepted.
   Claude Code 2.1.239's changelog fixed the same loss in Claude's own
   `/resume`. A bounded backward byte search finds the last title outside the
   tail, and a fixture places the rename outside both windows.
6. **The cost bound counts returned rows, not inspected transcripts.**
   Accepted. An aggregate budget of 1,000 opens and 64 MiB covers every read.
   Owned, duplicate and non-UUID files are rejected by name before they are
   opened, and excluded heads stop at their first record.
   `listForThread` stays out of `is_long_running`, because the budget bounds
   it.
7. **History stays enabled for read-only clients, and the claim that the web
   has no scope model is too broad.** Accepted in part. The claim is
   corrected. The primary environment disables History when its scope list is
   present and lacks operate. Remote connections keep the refusal fallback in
   v1, because they hold no granted scope. Recording the scope from the token
   response is the stated follow-up, so this one acceptance criterion is only
   partly met for remote environments.

Found while revising: once a copy's first turn wrote its transcript, the
copy would have been listed beside its source. Copies now take `copy:` thread
IDs, which the existing owner filter hides (`openInPanel`, step 2). The
refused-resume flag is limited to imported sessions, so a native thread's
early exit never points at History.
