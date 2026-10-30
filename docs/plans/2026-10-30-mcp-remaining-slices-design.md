# MCP for Outside Agents: Remaining Slices

Status: Proposed — awaiting approval. Issue #139. Extends the approved slice-1 design
(`docs/plans/2026-10-24-mcp-operate-server-design.md`, "slice 1" below) and does not
replace it. Verified at `ba143353d4` (`origin/claude/issue-batch-after-v0.13.0`, draft
PR #213).

## Goal

Finish what #139 lists beyond slice 1, so an outside agent can drive a whole change through
BiBCode: create a worktree, start and steer threads, answer their questions and approvals,
stage, commit, push, open and merge the pull request, use a terminal or a device preview,
and clean up afterwards. It can do this locally, over SSH, and over remote Streamable HTTP
with MCP OAuth.

### User decision (2026-10-30)

These are first-class tools for any MCP credential with operate access, with no separate
access level:

- answering permission approvals;
- destructive operations: worktree removal, discard, undo, revert, branch delete and
  force-push.

This supersedes three earlier statements:

- slice 1's "Approvals stay with a person" and its "omission is the control" rule
  (`apps/server/src/mcp/control.rs:8-10`, `docs/user/mcp.md` "Not available");
- the issue's "Omitted in slice 1" list;
- the extended scope's "Approval in the UI" rule for destructive operations, which put a
  server-held MCP approval card in front of each such call.

What protection remains is set out honestly in [Safety model](#c6-safety-model-for-destructive-tools-and-approvals).

### In scope

| Slice    | What                                                                                                                                                              |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F0**   | Foundation: tool families, kind-aware registration, stream invocation, recorded outcomes for RPCs without receipts, thread targets, the terminal setting contract |
| **A**    | Thread tools: `answer_approval`, `revert_thread_to_turn`, attachments on `start_thread`/`send_message`                                                            |
| **W**    | Worktree tools: list, create, removal plan, remove                                                                                                                |
| **G**    | Git write tools: stage, unstage, commit, undo commit, revert commit, push, force-push, fetch, pull, branch create/switch/delete, discard                          |
| **P**    | Pull request tools: create, list, view, checks, update, merge                                                                                                     |
| **T**    | Terminal tools under `terminal:operate`                                                                                                                           |
| **D**    | Device and browser preview tools for outside agents                                                                                                               |
| **R**    | Remote Streamable HTTP at `<environment>/mcp` with MCP OAuth                                                                                                      |
| **Z**    | Cross-cutting docs, runbooks, and the `bibcode-mcp` skill and evals                                                                                               |
| —        | `bibcode thread` CLI: designed in slice 1 ("CLI front end"), implemented in parallel by another writer, and not redesigned here (see [CLI](#bibcode-thread-cli))  |
| Deferred | The Tasks extension and resources, with reasons (see [Deferred](#deferred-tasks-and-resources))                                                                   |

### Out of scope

- Settings, credentials, the updater, pairing, relay management, and CLI session import.
  No tool reaches `server.updateSettings`, `/api/auth/*` administration, `updater.*`,
  `cloud.*`, `connect.*` or `agentSessions.*`. The audience rule still keeps an
  `mcp-client` session off every RPC and HTTP route except `/mcp` (slice 1). The new
  OAuth routes take no MCP bearer.
- The extended scope of 2026-10-27 (sections A and B). Where it overlaps a slice here, the
  slice here takes its place:
  - `scm_stage`, `scm_commit`, `scm_run_operation` and `scm_discard` become slice G;
  - `create_worktree` and `list_worktrees` become slice W;
  - `open_terminal_panel` becomes slice T.

  The rest needs its own design, because each part adds new server state or a new event
  kind: diagnostics tools, clone, files and transfers, `focus_ui`, `send_panel_message`,
  `changes_since`, `server_capabilities`, actor attribution, the server-side commit draft,
  webhooks, and per-environment capability sets. See Question 7.

## Current behavior (verified at ba143353d4)

Slice 1 (implemented):

- **Tool table.** `CLIENT_TOOLS` (`apps/server/src/mcp/control.rs:179-240`) and the
  dispatch `match` (`:467-482`) hold every thread tool.
  - `tool_spec` (`:258-263`) matches every `preview_*`/`device_*` name to one provider
    spec by prefix. A client-kind tool with those names therefore cannot be registered
    today.
  - `describe` hardcodes `destructiveHint: false` (`:566`).
  - `ToolSpec` has `scope`, `methods`, `waits` and `read_only`, but no destructive or
    idempotent flag (`:148-158`).
- **Local invocation.** `RpcRegistry::invoke_local` (`apps/server/src/rpc/session.rs:657-707`)
  runs `required_scope`, `authorize_session`, the admission gate, and then the handler,
  for **unary methods only**. Any other method gets `RpcMethodNotFoundError` (`:664`).
- **Retries.** `ToolCall::commands` stores the first commands in `mcp_tool_requests` and
  re-dispatches them, so the engine's command receipts replay them (`control.rs:851-995`,
  migration 58). That works only for commands that carry a `commandId` receipt.
- **Ceiling.** `McpAccess` levels are the thread runtime modes plus `read-only`
  (`control.rs:63-101`). `read-only` hides mutating tools (`:403-413`, `:449-456`).
  `check_thread_mode` refuses work that would advance a thread above the ceiling
  (`:831-846`).
- **Credential.** `issue_mcp_pairing_link` (`apps/server/src/auth/service.rs:2909`)
  mints `orchestration:read orchestration:operate` and subject `mcp-client`.
  - `authenticate_token` refuses that subject (`:897-908`); only
    `authenticate_mcp_client` accepts it (`:913-925`).
  - Sessions last 30 days (`:40`).
  - Tokens are HMAC-signed `payload.signature` with `sid`, `sub` and `scopes`
    (`apps/server/src/auth/token.rs`).
- **`/mcp`.** The route (`apps/server/src/production/http_routes.rs:354`) and the handler
  (`connect_mcp.rs:965-1036`) refuse a foreign `Origin` with 403 (`:971-976`).
  - A bearer resolves to a provider token in `McpState` or to an `mcp-client` session.
    Anything else gets 401 with a bare `WWW-Authenticate: Bearer` and no
    `resource_metadata` (`invalid_mcp_credential`, `connect_mcp.rs:268-279`).
  - The body cap is 4 MiB (`http_routes.rs:16`).
- **Auth HTTP.** `/oauth/token` serves only the RFC 8693 token exchange
  (`auth/http.rs:40`). There is no authorization endpoint, client registration or
  well-known metadata route (`docs/cloud/environment-auth.md` "Standards profile": "not a
  general-purpose OAuth authorization server").

RPC surface for the new tools:

- **Methods and scopes.** Methods are listed in `apps/server/src/rpc/methods.rs:56-346`
  and their scopes in `apps/server/src/auth/scope.rs:11-200`. Every worktree, `vcs.*`
  write, `gitManager.*` write, `pullRequests.runAction`, `git.runStackedAction`,
  `uploads.*`, `device.*` write and `preview.*` write needs `orchestration:operate`.
  Every `terminal.*` needs `terminal:operate` (`scope.rs:179-192`).
- **Worktrees.**
  - `worktree.createManaged`, `worktree.remove` and `worktree.removeFromBibCode` take a
    `commandId` and replay by receipt and payload digest
    (`production/worktree_catalog_rpc.rs:1892-1898`, `:2048-2054`; inputs at
    `packages/contracts/src/rpc.ts:405-470`).
  - Removal is two-step: `worktree.getRemovalPlan` returns `planToken`, `generation`, and
    the change counts (`packages/contracts/src/worktree.ts:196-208`).
  - Both removal paths build a `RemovalTrace` and call
    `worktree_audit::record_removal_outcome` (`worktree_catalog_rpc.rs:1885`,
    `:1919-1927`, `:2041`, `:2075-2083`, `:2090-2114`).
- **Git manager.**
  - `gitManager.commit`, `undoCommit`, `discard`, `stagePartial`, `unstagePartial` and
    `discardPartial` are unary mutations with **no** receipt
    (`production/git_manager_rpc.rs:1011-1025`; inputs at
    `packages/contracts/src/gitManager.ts:434-485`).
  - `gitManager.runOperation` is a **stream** (`git_manager_rpc.rs:1027`). It carries
    branch create, checkout, rename and delete; fetch; pull; push; publish-branch;
    force-push; stash; merge; rebase; cherry-pick; revert; reset; and tags
    (`gitManager.ts:218-339`). It emits `started`, `output`, `finished` and `failed`
    (`:343-363`).
  - Force-push runs `--force-with-lease` in the repository layer
    (`apps/server/src/git/repository.rs:4460-4461`).
- **VCS.** `vcs.stageFiles` and `vcs.unstageFiles` take `{cwd, filePaths}`
  (`packages/contracts/src/git.ts:130-137`).
- **Pull requests.**
  - `git.runStackedAction` (create, commit-push and commit-push-PR) is a **stream**
    (`production/git_vcs.rs:225-229`, `:1483-1530`). Its `actionId` correlates events
    and is not an idempotency key.
  - `pullRequests.runAction` is unary. It covers `editPullRequest`, `setDraft`, `merge`
    (with `headSha`, `bypass` and `auto`), `close` and others
    (`packages/contracts/src/pullRequests.ts:687-831`; registration at
    `production/pull_requests_rpc.rs:439-446`).
  - `pullRequests.list`, `get` and `getChecks` are unary reads.
- **Approvals.** `thread.approval.respond` is an orchestration command with
  `decision ∈ {accept, acceptForSession, decline, cancel}`
  (`packages/contracts/src/orchestration.ts:145-150`, `:980-987`). It goes through
  `orchestration.dispatchCommand`, so receipts replay it.
- **Checkpoints.** `thread.checkpoint.revert {turnCount}` is an orchestration command
  (`orchestration.ts:998-1004`, `orchestration/engine.rs:654`).
- **Attachments.**
  - `thread.turn.start` accepts up to 8 attachments of at most 10 MiB each
    (`orchestration.ts:156-157`, `:910`).
  - A staged attachment names an `uploadId` (`orchestration.ts:238-255`). Uploads are
    `chat-attachment` targets with 1,398,104-character append chunks
    (`packages/contracts/src/uploads.ts:7-31`), owned by the uploading session
    (`production/uploads_rpc.rs:84-100`, `:173`).
- **Terminals.**
  - `terminal.open` and `terminal.write` are unary (`production/server_terminal.rs:788`,
    `:912`); `terminal.attach` is a stream (`:814`).
  - Writes are at most 65,536 characters (`packages/contracts/src/terminal.ts:112-115`).
  - Terminal ids are chosen by the client (`terminal.ts:77`).
  - Scrollback is bounded at 5,000 lines (`terminal/manager.rs:188`) and 1 MiB
    (`terminal/history.rs:8`). It exposes only `snapshot()` of what it retains, with no
    monotonic offset (`history.rs:93-140`).
- **Previews and devices.**
  - Provider preview calls carry a `PreviewScope` with `owner_thread_id` and
    `provider_session_id` (`connect_mcp.rs:149-158`). The automation broker keys tab
    assignment by `environment_id ‖ provider_session_id`
    (`mcp/preview_automation.rs:317`) and needs a connected UI host (`:319-340`).
  - Device tools act for `owner_thread_id` and exist only while device previews are on
    (`connect_mcp/device_tools.rs:1-6`, `:27-33`).
- **Profiler.** `is_long_running` derives every `mcp.<tool>` from its `ToolSpec`
  (`diagnostics/profiler/latency.rs:106-113`). `gitManager.runOperation` and
  `git.runStackedAction` are not in its list (`:114-175`).
- **Skill.** `docs/skills/bibcode-mcp/evals/evals.json` eval 2 ("just approve it")
  expects the agent to refuse and relay the approval.

## Cross-cutting decisions

These rules apply to every tool slice. F0 builds the mechanisms.

### C1. Tool families and registration

**Alternatives:**

- Keep growing `CLIENT_TOOLS` and the `match` in `control.rs`. This is zero refactoring,
  but every slice then edits the same three places (table, `tool_text`, dispatch), and
  six writers would conflict.
- Split by family (**chosen**). `mcp/tools/{threads,worktrees,git,pull_requests,terminals,previews}.rs`
  each export `pub(crate) const TOOLS: &[ToolSpec]`, a `text(name)` for the description
  and schema, and an `async fn call(&ToolCall, name)`. `control.rs` keeps `McpControl`,
  admission, the per-call checks, and one `FAMILIES` array. A slice then adds one line
  there.

The changes to registration:

- **`ToolSpec` fields.** It gains `destructive: bool`, `idempotent: bool`,
  `open_world: bool`, and `scope` widened to any scope constant (for
  `terminal:operate`). `describe` emits the hints from these fields.
- **Two meanings of `waits` split.** Slice 1 uses `waits` both for `is_long_running`
  and as an admission slot: `McpControl::admit` counts it toward 4 waits per session and
  32 per environment (`control.rs:49-51`, `:510-542`). Network tools and device boots are
  long-running but do not idle on an engine subscription, so `ToolSpec.waits` becomes
  `long_running` (read by `is_long_running`) and `holds_wait_slot` (read by `admit`).
  Only `wait_for_thread` holds a slot. A push or a 180 s device boot must not use up a
  session's waits.
- **Kind-aware lookup.** `tool_spec(kind, name)` replaces the prefix match, so client
  twins of `preview_*`/`device_*` can exist. `authorize_call` and `is_long_running` pass
  the kind (`is_long_running` asks both kinds).
- **A test** iterates every family and asserts three things:
  - names are unique per kind;
  - each `scope` equals `required_scope` of every method in `methods`, as slice 1's
    `every_tool_scope_is_its_rpc_methods_scope` does;
  - every `destructive` tool appears in the destructive-logging set (C7).

### C2. Annotations

These follow the 2026-07-28 tool annotations, plus Claude Code's documented behavior:
`readOnlyHint` tools run in parallel, and an `idempotentHint` or `readOnlyHint` call may be
**repeated once on a new connection** after the old one closed.

- **`readOnlyHint`**: the tool changes nothing.
- **`destructiveHint`**: the tool can lose work or rewrite shared history:
  - `remove_worktree`, `git_discard`, `git_undo_commit`, `git_force_push`,
    `git_delete_branch`;
  - `revert_thread_to_turn`, `merge_pull_request`, `answer_approval`;
  - `terminal_write`, `terminal_close`.
- **`git_revert_commit` is not destructive.** It adds a commit and loses nothing. It is
  still listed in the user's set of operations in the Safety model, and is logged as
  destructive.
- **`idempotentHint`** is set only when a blind repeat with the same arguments is
  harmless **without** a `clientRequestId`:
  - reads;
  - `interrupt_turn`;
  - `git_stage` and `git_unstage`;
  - `git_fetch`;
  - `terminal_resize`.

  Destructive tools never carry it, so a harness never repeats them on its own.

- **`openWorldHint`** marks tools that touch a remote or hosting service: push, fetch,
  pull, and every pull request tool.
- **`anthropic/requiresUserInteraction` is not set** (Question 2). In Claude Code it
  forces a prompt even in bypass mode, and it denies the call in `dontAsk` and through
  `--permission-prompt-tool`. That would make the user's "included fully" decision
  unusable in headless automation.

### C3. Stream invocation

Push, fetch, pull, branch operations, revert and create-PR are streams, so B1 cannot reach
them.

**Alternatives:**

- Map to unary siblings where they exist (`vcs.pull`, `vcs.createRef`, `vcs.switchRef`).
  Force-push, branch delete, revert and create-PR have none, so this alone does not
  suffice.
- Call the services directly from the tools. This bypasses scope, admission and timing.
  Rejected.
- **Chosen:** `RpcRegistry::invoke_local_stream(tag, payload, context, cancellation, budget)`.
  It runs the same scope and admission steps as `invoke_local`, then the registered
  stream handler. It drains the chunks into a bounded collector: the last 64 `output`
  events, capped at 16,000 characters, and the terminal event. It returns
  `Ok(final event)` or `Err(typed error)`.
  - A `failed` event becomes a typed tool error carrying its `code` and `blocked` reason.
  - Cancelling the token, or reaching the budget, drops the receiver. This is the same
    path a WebSocket client's disconnect takes, so the handler stops as it does today.
  - One mechanism serves every stream-only operation, and the Source Control panel keeps
    using the same methods.

### C4. Retries for RPCs without receipts

Slice 1's replay works because the engine's receipts make a byte-identical re-dispatch
safe. Worktree methods have receipts too (`commandId`), so slices W and A reuse slice 1's
`commands()` path unchanged. `gitManager.*`, `vcs.stage/unstageFiles`,
`git.runStackedAction`, `pullRequests.runAction` and `terminal.*` have none: re-running a
commit makes a second commit, and re-running a PR create opens a second PR.

**Alternatives:**

- No `clientRequestId` on these tools; the agent checks state before it retries. This is
  simplest, but agents retry after transport errors, and the skill's whole retry rule
  rests on the id.
- Add receipts to every git and PR handler. This gives exactly-once execution, but it is
  a large change across `git_manager_rpc.rs`, `git_vcs.rs` and `pull_requests_rpc.rs`,
  for one consumer.
- **Chosen: at-most-once with a recorded outcome.** Migration 59 adds `state` and
  `outcome_json` to `mcp_tool_requests`. This is a deliberate extension of slice 1's "the
  tool layer keeps no replay logic". Its replay logic is limited to returning an answer
  that was recorded, and it never re-runs work.

How a call with a `clientRequestId` runs:

1. One SQLite job runs `INSERT OR IGNORE` with `state = 'running'` and the exact RPC
   payload, then reads the row back. The tool and digest checks are slice 1's
   (`idempotency_conflict`).
2. **New row.** The call runs as a task owned by `McpControl`, so a cancelled MCP call
   stops waiting but not the work. It writes `state = 'done'` with the bounded tool
   result, or `state = 'failed'` with the typed error. An in-process claim map holds the
   key while the task runs.
3. **Row is `done` or `failed`.** The call returns the stored outcome unchanged.
4. **Row is `running` and the claim is held** (a concurrent retry). The call awaits the
   claim within its own deadline, then reads the outcome.
5. **Row is `running` with no claim** (the server restarted or crashed mid-call). The
   call returns `McpOutcomeUnknownError`: "BiBCode cannot tell whether this ran. Check
   `git_status` (or `view_pull_request`), then retry with a new clientRequestId." It
   never re-runs.

Without a `clientRequestId`, a call runs inline and cancellation propagates, as today.
Stored outcomes are tool results, capped at 80,000 characters. They are pruned at 24 hours
with their rows, like slice 1's.

### C5. Thread targets and paths

Every workspace tool takes `threadId`. The server resolves `cwd` (the thread's worktree
path, else the project root) and `projectId`. `git_status`'s resolver (`control.rs:1609-1630`)
moves to a shared `mcp/target.rs`.

Tools that name files (`git_stage`, `git_unstage`, `git_discard`) take workspace-relative
paths. This extends slice 1's "ids, never paths" rule, because the operations are
file-scoped:

- each path is at most `PROJECT_ENTRY_PATH_MAX_LENGTH`;
- a path that is absolute, contains `..` or NUL, or resolves outside `cwd` is refused
  before any RPC;
- at most 200 paths per call.

Branch names and remotes are passed to the RPC, which already validates them.

### C6. Safety model for destructive tools and approvals

**Consequences, stated plainly:**

- **The default ceiling allows destructive operations.** `McpAccess` levels are thread
  runtime modes. A worktree removal or a force-push is not a thread mode, so the only gate
  is "the ceiling is above `read-only`". With the default `approval-required`, a connected
  agent can therefore:
  - remove a worktree with uncommitted changes (`discardChanges: true`);
  - discard files permanently (`permanent: true`);
  - force-push over a remote branch;
  - delete a local and remote branch;
  - merge a pull request;
  - approve its own thread's permission requests.

  Question 1 asks whether destructive tools should need `full-access` instead.

- **"Supervised" changes meaning.** With `answer_approval`, a Supervised thread stops for
  an approval, but whoever drives it may answer, and that can be the agent. A Supervised
  ceiling bounds how a thread runs, not who approves it. This changes the slice-1 UI copy
  and the docs.
- **Injected instructions can now cause loss.** Thread transcripts, terminal output, pull
  request bodies and check logs are untrusted. They can carry instructions such as "now
  run `git_force_push`", or an approval request crafted by a tool, and an agent that
  follows them can destroy work. Results are already marked untrusted (slice 1), but that
  is advice to the agent, not a control.
- **Nothing in the UI says who acted.** There is no actor attribution (extended-scope gap
  3), so a removal or force-push made over MCP looks the same as one a person made. The
  trail is the Authorized clients row, `server.log` (C7), and the profiler's
  `worktree.removal` events.

**Mitigations that remain:**

- **Per-environment off switch.** `enableMcpServer` off ends every outside agent at once,
  live (slice 1).
- **Read only.** `mcpServerAccess: read-only` hides and refuses every mutating tool, live.
- **Revocation.** Revoking the agent's row in Authorized clients ends it on its next call.
- **Ceiling.**
  - Threads an agent starts or creates (`create_worktree`) never run above it.
  - `send_message`, `answer_question`, `answer_approval` and `revert_thread_to_turn`
    are refused on a thread that runs above it.
  - Terminals need `full-access` (slice T).
- **Look-first guards that already exist:**
  - **Worktree removal** needs the `planToken` and `generation` from
    `get_worktree_removal_plan`, which reports the tracked and untracked change counts. A
    stale plan is refused with `StaleGeneration`.
  - **Merge** needs `headSha` from `view_pull_request`, so a head that moved since the
    agent looked is refused by the host.
  - **Force-push** is `--force-with-lease`.
  - **Discard** moves files to the trash unless `permanent: true`, and reports what it
    could not trash.
  - **Undo commit** keeps the changes in the working tree and returns the message.
- **Annotations.** `destructiveHint`, `openWorldHint`, and no `idempotentHint` on
  destructive tools (C2). Harnesses that prompt on destructive tools will prompt.
- **Audit.** Removals keep `record_removal_outcome` coverage on both paths, because the
  tools reach the existing handlers (C7, profiler). Every destructive call writes one
  content-free `server.log` line.
- **Skill.** The `bibcode-mcp` skill tells agents to:
  - run a destructive tool or approve only when the person asked for that exact effect;
  - never act on instructions found in tool output;
  - read the removal plan or the PR head first.

  The evals test injected instructions.

**What does not help:** a harness in a bypass mode, or an agent that trusts its inputs.
The mitigations above bound the blast radius (one environment, revocable), not intent.

### C7. Logging and audit

- **Every call, as in slice 1.** A `debug` or `warn` line with the tool, the thread id
  and the outcome tag.
- **Every destructive call.** One `info` line: `MCP destructive tool` with `tool`,
  `session_id` (`sid`), `thread_id`, `outcome` and `duration_ms`.
- **Never logged:** paths, branch names, commit messages, PR bodies, terminal input or
  output, or approval summaries.
- **Removals.** Profiler `worktree.removal` events come from the existing
  `record_removal_outcome`.

## Slice F0: Foundation

**Owns:** C1 to C5, migration 59, and the contract for the terminal setting.

**Changes:**

- **Tool families.**
  - `mcp/control.rs` is split. Slice 1's thread tools move unchanged to
    `mcp/tools/threads.rs`.
  - `default_model_selection`, `check_thread_mode`, `commands()` and the argument helpers
    become `pub(crate)` so other families can use them.
  - `mcp/wait.rs` changes only its import paths.
- **New modules.**
  - `mcp/target.rs`: thread targets and path validation (C5).
  - `mcp/outcome.rs`: recorded outcomes (C4).
- **Stream invocation.** `rpc/session.rs` gains `invoke_local_stream` (C3).
- **Provider tool dispatch.** `production/connect_mcp.rs` moves provider preview and
  device dispatch (`call_tool`, `:1175-1238`) into a function both principal kinds can
  call, `mcp::tools::previews::run(scope, name, arguments, cancellation, invoker, devices)`.
  Provider behavior does not change. The client twins come in slice D.
- **Migration 59, `McpToolOutcomes`.** `ALTER TABLE mcp_tool_requests ADD COLUMN state TEXT
NOT NULL DEFAULT 'commands'` and `ADD COLUMN outcome_json TEXT`. Slice-1 rows read as
  `commands` and keep their receipt replay.
- **Terminal setting contract.**
  - `ServerSettings`/`ServerSettingsPatch` gain `mcpAllowTerminals` (default `false`),
    with fixtures (`packages/contracts/src/settings.ts`).
  - It is validated and published on `mcp_server_signal()`, and `McpServerSettings` gains
    `allow_terminals` (`production/control.rs`, `mcp/control.rs:106-135`).
- **Issuer.** `issue_mcp_pairing_link` takes an optional extra-scope list, which only
  `terminal:operate` may use.
  - The relay asks for it when `mcpAllowTerminals` is on **and** the ceiling is
    `full-access` at mint time.
  - The relay mints on its first request (slice-1 implementation note).
- **Profiler.** `diagnostics/profiler/latency.rs` gets the kind-aware lookup.
- **Tests.** `production/mcp_tools_tests.rs` becomes a directory module
  (`mcp_tools_tests/mod.rs` plus `threads.rs`), so each slice adds its own test file.

**Failure and cancellation:**

- `invoke_local_stream` drops its receiver on cancel, budget and shutdown.
- Recorded-outcome tasks are tracked in `McpControl` and stop at `McpControl::shutdown`.
  A row left `running` answers `McpOutcomeUnknownError` on its next retry, which is never
  a false success.

**Tests (written to fail first):**

- **Wait slots.** Five concurrent `git_push` calls and a `device_open` do not take a wait
  slot, and a fifth `wait_for_thread` is still refused with `McpBusyError`.
- **Kind-aware names.** A client tool named `device_list` coexists with the provider's,
  and each kind's `tools/list` shows only its own.
- **Hints.** `describe` emits `destructiveHint: true` for a spec marked destructive.
  Today it hardcodes `false`.
- **Stream invocation**, through a fake stream handler:
  - `failed` becomes a typed error with `code`;
  - cancel mid-stream drops the receiver;
  - an `output` flood is capped at the collector's bound;
  - a stream method without the scope is refused before the handler runs.
- **Recorded outcomes:**
  - two sequential calls with one key run the handler once and return the same result;
  - concurrent calls run it once;
  - a `running` row with no claim returns `McpOutcomeUnknownError` and does not run;
  - another digest returns `idempotency_conflict`;
  - a slice-1 `commands` row still replays by receipt.
- **Paths.** Path validation refuses absolute paths, `..`, NUL, a symlink that escapes
  `cwd`, and 201 paths.
- **Unchanged behavior.** The slice-1 integration suite passes unchanged after the move,
  and the provider `preview_*`/`device_*` suite in `connect_mcp/tests.rs` passes
  unchanged.

## Slice A: Thread tools (approvals, checkpoint revert, attachments)

### Approvals

**Alternatives:**

- Keep the upstream stance. This is superseded by the user decision.
- A separate opt-in or `requiresUserInteraction`. This is excluded by the decision; see
  Question 2 for the annotation alone.
- **Chosen:** a first-class `answer_approval`.

**Tool:** `answer_approval { threadId, requestId, decision, clientRequestId? }` maps to
`thread.approval.respond` (operate).

- `decision` is `accept`, `acceptForSession`, `decline` or `cancel`, the contract's own
  values.
- Hints: `destructiveHint: true`, `idempotentHint: false`.
- It refuses a question's `requestId`, pointing to `answer_question`, and an id that is
  not pending.
- **Ceiling.** Accepting resumes the provider, so `check_thread_mode` applies, as for
  `answer_question` (slice-1 review fix 2). Declining and cancelling stop work instead of
  advancing it, so they are allowed at any operate level, as `interrupt_turn` is.
- **Retries.** These follow slice 1's receipt path. The stored request is resolved first.
  Slice 1's `check_unaccepted` checks the thread's mode for every stored command of a
  call that names a thread, so a `decline` or `cancel` passes `thread_id: None` to
  `commands()`. A retried decline is then judged as the first call was, and only an
  `accept` meets the ceiling on retry.
- **Pending requests.** `list_pending_requests` now returns each approval with
  `answerWith: "answer_approval"`, its `kind`, its summary, and the decisions allowed.
  `answer_question` no longer says approvals cannot be answered over MCP.

### Checkpoint revert

**Tool:** `revert_thread_to_turn { threadId, turnCount, clientRequestId? }` maps to
`thread.checkpoint.revert` (operate).

- Hints: `destructiveHint: true`. It restores the workspace to the checkpoint after
  `turnCount`, which discards the file changes of later turns.
- It is refused on a thread above the ceiling, and while a turn runs (the engine's own
  rule; verify the error tag).
- The result names the turn reverted to. `get_turn_diff` shows the turns that remain.

### Attachments

**Alternatives:**

- Defer them.
- Inline `dataUrl`s in the stored command. This is the simplest path, but it parks up
  to 4 MiB per retry row in SQLite with no quota.
- **Chosen:** staged uploads through the existing upload service. Its per-owner quota
  then bounds what an agent can park.

**How it works:**

- `start_thread` and `send_message` gain
  `attachments: [{ name, mimeType, data }]`, where `data` is base64:
  - at most 8 attachments, the engine's limit;
  - at most 3 MiB decoded per call, because the request body is capped at 4 MiB;
  - images (`image/png`, `image/jpeg`, `image/gif`, `image/webp`) or files, by the
    contract's own split.
- The tool's `fresh()` step decodes each one and stages it:
  - it calls `uploads.begin` with a `chat-attachment` target, `sizeBytes` and `sha256`;
  - it calls `uploads.append` in 1,398,104-character chunks;
  - both calls go through B1 under the MCP session, which becomes the upload's owner.

  The stored commands then carry `StagedUploadChatAttachment` entries (`uploadId`, never
  the data), so a retry with the same `clientRequestId` re-dispatches the same upload
  ids.

- **Larger files** are deferred. A chunked `upload_attachment` tool is a follow-up if
  agents need more than 3 MiB.
- **Verify in implementation:** how long an incomplete or unconsumed upload lives. If it
  is shorter than the 24-hour retry window, a retry after expiry gets a typed
  `McpAttachmentExpiredError` ("send again without clientRequestId"), never a turn
  without its attachments.

**Trust boundary:** attachment bytes go only to the provider, as a UI attachment does, and
are never logged.

**Tests (fail first):**

- `answer_approval` accept resumes a faked approval, and decline ends it;
- a question id is refused;
- accepting on a Full access thread with a Supervised ceiling is refused, and declining
  it is allowed;
- a retry after the approval resolved replays the receipt;
- `list_pending_requests` shows `answer_approval`;
- `revert_thread_to_turn` restores the faked checkpoint;
- an attachment reaches the faked provider's turn as a staged upload;
- a retry with the same key creates no second upload;
- 9 attachments, or more than 3 MiB, are refused before any upload;
- the upload quota error comes back typed.

## Slice W: Worktree tools

**Alternatives:** expose `worktree.adopt`, `retarget` and `updateDiscoveryPolicy` too.
They are not requested; they remain RPC-only.

| Tool                        | Arguments                                                                                                                                                                                    | Maps to                                                                                                  | Result                                                                                                                        | Hints                           |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `list_worktrees`            | `projectId`, `limit` (50, at most 200), `cursor`                                                                                                                                             | `vcs.refreshWorktreeCatalog` (read; returns the catalog snapshot, `worktree_catalog_rpc.rs:915-926`)     | Entries: `worktreeKey`, `hostThreadId`, branch, `path`, availability, `managed`, change flags; `nextCursor` (with `fit_list`) | read-only, idempotent           |
| `create_worktree`           | `projectId`, `branch`, `newBranch?`, `baseBranch?`, `title?`, `providerInstanceId?`, `model?`, `runtimeMode?`, `clientRequestId?`                                                            | `worktree.createManaged` (operate, receipt)                                                              | `threadId` (the host thread), `path`, `branch`                                                                                | not destructive                 |
| `get_worktree_removal_plan` | `threadId`                                                                                                                                                                                   | `worktree.getRemovalPlan` (read)                                                                         | `planToken`, `generation`, `registered`, `locked`, `trackedChangeCount`, `untrackedFileCount`, `pruneImpact`                  | read-only                       |
| `remove_worktree`           | `threadId`, `planToken`, `expectedGeneration`, `mode` (`delete`, or `detach` = remove from BiBCode only), `discardChanges` (false), `confirmRepositoryWidePrune` (false), `clientRequestId?` | `worktree.remove` (`delete-git-worktree`, `forceDirty = discardChanges`) or `worktree.removeFromBibCode` | `threadRemoved`, `gitOutcome`, `orphanCleanupPending`, `detail`                                                               | **destructive**, not idempotent |

Notes:

- **`create_worktree` thread defaults.** The model is resolved the way `start_thread`
  resolves it, and `runtimeMode` defaults to the ceiling and is capped by it. The
  `commandId` and `threadId` are frozen in the stored request, so a retry replays by
  receipt.
- **`remove_worktree` sends the plan's own values.** It passes `planToken` and
  `generation` exactly as the plan returned them. It never fetches a fresh plan itself,
  so the agent must have read the change counts. The description says so.
- **A host thread has no worktree** when it runs in the project root. Such a removal is
  refused before the RPC with `McpNotAWorktreeError`.

**Profiler.**

- Both removal modes reach the handlers that call `record_removal_outcome`
  (`worktree_catalog_rpc.rs:1885`, `:2041`). No new removal path exists, so no new audit
  call is needed.
- A test with the profiler on asserts that one `worktree.removal` event follows an MCP
  removal, and none follows a replayed retry (the handler sets `replayed`).
- `mcp.create_worktree` and `mcp.remove_worktree` are long-running through their
  methods (`latency.rs:162`, `:168`).

**Failure and concurrency.**

- A UI removal and an MCP removal race through the same command claim and generation
  check, and one gets `StaleGeneration`.
- After a cancellation, the removal finishes server-side: the handler's own
  `operation_runtime` already outlives the caller.

**Tests (fail first):**

- create, then list shows the worktree, and a retry returns the same `threadId`;
- remove with a stale `expectedGeneration` is refused;
- remove with `discardChanges: false` on a dirty tree is refused with the handler's
  reason;
- `detach` keeps the directory;
- the profiler event appears exactly once across a retry;
- `read-only` hides all three mutating tools;
- with a Supervised ceiling, `create_worktree runtimeMode: full-access` is refused.

## Slice G: Git write tools

Every tool here takes `threadId` (C5), and the server adds `cwd` and `projectId`. Retries
use recorded outcomes (C4). Push, fetch and pull are marked `long_running: true`, because they
wait on a network.

| Tool                | Arguments                                                                                               | Maps to                                                                                                            | Hints                           |
| ------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| `git_stage`         | `paths[]`                                                                                               | `vcs.stageFiles`                                                                                                   | idempotent                      |
| `git_unstage`       | `paths[]`                                                                                               | `vcs.unstageFiles`                                                                                                 | idempotent                      |
| `git_commit`        | `summary`, `description?`, `clientRequestId?`                                                           | `gitManager.commit` with `amend: false`, `noVerify: false`, `signoff: false`, `allowEmpty: false`, `coAuthors: []` | not idempotent                  |
| `git_undo_commit`   | `clientRequestId?`                                                                                      | `gitManager.undoCommit`                                                                                            | **destructive**                 |
| `git_revert_commit` | `sha`, `clientRequestId?`                                                                               | `runOperation revert`                                                                                              | not destructive (adds a commit) |
| `git_push`          | `remote?` (upstream or `origin`), `branch?` (current), `remoteBranch?`, `pushTags?`, `clientRequestId?` | `runOperation push`, or `publish-branch` when there is no upstream                                                 | open world                      |
| `git_force_push`    | the same as `git_push`                                                                                  | `runOperation force-push` (`--force-with-lease`)                                                                   | **destructive**, open world     |
| `git_fetch`         | `remote?`                                                                                               | `runOperation fetch`                                                                                               | idempotent, open world          |
| `git_pull`          | `remote?`, `clientRequestId?`                                                                           | `runOperation pull`                                                                                                | open world                      |
| `git_create_branch` | `name`, `startPoint?`, `checkout` (true)                                                                | `runOperation branch-create`                                                                                       | —                               |
| `git_switch_branch` | `name`, `carryChanges?` (`stash` or `bring`)                                                            | `runOperation branch-checkout`                                                                                     | —                               |
| `git_delete_branch` | `name`, `force` (false), `deleteRemote` (false), `clientRequestId?`                                     | `runOperation branch-delete`                                                                                       | **destructive**                 |
| `git_discard`       | `paths[]`, `permanent` (false), `clientRequestId?`                                                      | `gitManager.discard` (`permitPermanent = permanent`)                                                               | **destructive**                 |

**Not exposed:**

- **Amend and `noVerify`.** `git_undo_commit` followed by `git_commit` covers amend, and
  skipping hooks removes a safety net the user set up.
- **The rest of `runOperation`:** rebase, reset, squash, reorder, cherry-pick, stash,
  tags, merge and conflict resolution. They are not requested, and each widens the
  ways history can be lost. Adding one later is a row in this family.
- **Partial (hunk) staging.** `stagePartial` needs a `baseGeneration` the agent cannot
  observe.

**Results.**

- Each tool returns the operation's `finished.message`, or the commit's `sha`.
- Then comes a fresh `git_status`-shaped summary: branch, ahead/behind, and changed
  files capped by `fit_list`.
- Output lines from the stream are returned only when the call fails: the last 16,000
  characters, marked untrusted. Git hooks print arbitrary text.

**Failure.**

- A `blocked` reason, such as a rebase in progress or a dirty tree, comes back as a
  typed `GitManagerOperationError` with its `code` and `blocked`.
- Cancelling a call with a key stops the wait, not the push (C4).
- Cancelling a call without a key cancels the stream as a UI disconnect does.

**Concurrency.** Two calls on one repository are serialized by the handler's existing
mutation lease (`run_mutation`, `git_manager_rpc.rs:460`). Nothing new is needed.

**Profiler.** No new child processes: git runs through the existing supervised repository
layer. `mcp.git_push`, `mcp.git_force_push`, `mcp.git_fetch` and `mcp.git_pull` are
`long_running: true`; none holds a wait slot.

**Tests (fail first), against a real temporary repository and a bare remote:**

- stage, commit and push land on the bare remote;
- `git_commit` with one key twice makes one commit;
- `git_force_push` after the remote moved is refused by the lease;
- `git_discard` with `permanent: false` trashes files, or reports `trashUnavailable`;
- `git_undo_commit` returns the message and leaves the changes;
- `git_delete_branch` with `deleteRemote: true` removes both branches;
- a path that escapes the workspace is refused;
- a blocked operation returns its typed reason;
- a cancelled push with a key still records `done`, and the retry returns it;
- a captured tracing subscriber never sees a commit message, path or branch name.

## Slice P: Pull request tools

| Tool                  | Arguments                                                                                             | Maps to                                                        | Hints                       |
| --------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------- |
| `list_pull_requests`  | `threadId`, `state` (`open`), `cursor?`                                                               | `pullRequests.list`                                            | read-only, open world       |
| `view_pull_request`   | `threadId`, `number`                                                                                  | `pullRequests.get`                                             | read-only, open world       |
| `pull_request_checks` | `threadId`, `number`                                                                                  | `pullRequests.getChecks`                                       | read-only, open world       |
| `create_pull_request` | `threadId`, `title`, `body?`, `baseBranch`, `headBranch?`, `draft?`, `clientRequestId?`               | `git.runStackedAction` with `action: "create_pr"` (stream, C3) | open world                  |
| `update_pull_request` | `threadId`, `number`, `title?`, `body?`, `draft?`, `clientRequestId?`                                 | `pullRequests.runAction` (`editPullRequest`, `setDraft`)       | open world                  |
| `merge_pull_request`  | `threadId`, `number`, `method`, `headSha`, `deleteBranch` (false), `auto` (false), `clientRequestId?` | `pullRequests.runAction merge` with `bypass: false` always     | **destructive**, open world |

**Results.**

- `view_pull_request` returns the detail with its body capped at 16,000 characters plus
  its full length, the head SHA, merge readiness, and the checks summary.
- The timeline, files and comments are not in this slice. Body and checks text are
  untrusted.

**Decisions.**

- `bypass` (admin merge past branch protection) is never sent.
- `headSha` is required, so a merge is refused when the head moved since the agent
  looked.
- `create_pull_request` reuses the stacked action that creates a pull request in the
  UI, so the host-specific defaults and the warnings for options it could not apply are
  the UI's.

**Retries.** These use recorded outcomes (C4). A create whose outcome is unknown after a
crash tells the agent to call `list_pull_requests` for the head branch before it creates
again.

**Profiler.** Every method here is in `is_long_running` (`latency.rs:134-146`), and
`create_pull_request` is `long_running: true` because its method is a stream.

**Tests (fail first), with a faked hosting service:**

- create returns a number and URL, and a keyed retry creates none;
- merge with a stale `headSha` is refused;
- merge never sends `bypass`;
- view caps a long body and reports its length;
- an unavailable host (`PullRequestsContext.status: "unavailable"`) comes back as a
  typed error, not an empty list.

## Slice T: Terminals

**What this grants.** A terminal runs any command as the server's user. This is a wider
grant than every tool above, and terminal output is a second channel for injected
instructions.

### How the scope is granted

**Alternatives:**

- A consent step per credential only. The stdio relay has no consent page, and the data
  root can already mint anything.
- A new access level. This is rejected by the user decision for destructive tools, and
  it would be the second ceiling dimension.
- **Chosen:** three conditions, all checked on every call. The setting and the ceiling
  are read live; the scope is fixed at mint.
  1. **The setting** `mcpAllowTerminals` (default **off**) is on.
  2. **The credential holds `terminal:operate`.** The stdio relay asks for it when the
     setting is on and the ceiling is `full-access` at mint time (F0). The OAuth approval
     card offers it under the same two conditions (slice R).
  3. **The effective ceiling is `full-access`.** Full access is the only level at which a
     thread runs commands without approval, so an agent's terminal, which runs any
     command, needs the same.

Turning the setting off, or lowering the ceiling, hides and refuses the tools at once.
Turning it on reaches an agent only after its MCP server restarts and mints again, as the
ceiling does.

### Tools

| Tool              | Arguments                                                                | Maps to                                                                                          | Hints                               |
| ----------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ----------------------------------- |
| `terminal_list`   | `threadId`                                                               | the terminal manager's session list for the thread                                               | read-only                           |
| `terminal_open`   | `threadId`, `cols?`, `rows?`                                             | `terminal.open` with the thread's `cwd`, a server-minted `terminalId`, and no `command` or `env` | —                                   |
| `terminal_write`  | `threadId`, `terminalId`, `data` (≤ 16,384 characters)                   | `terminal.write`                                                                                 | **destructive**                     |
| `terminal_read`   | `threadId`, `terminalId`, `cursor?`, `tailChars?` (4,000), `raw` (false) | a new bounded history read                                                                       | read-only                           |
| `terminal_resize` | `threadId`, `terminalId`, `cols`, `rows`                                 | `terminal.resize`                                                                                | idempotent                          |
| `terminal_close`  | `threadId`, `terminalId`                                                 | `terminal.close` (`deleteHistory: false`)                                                        | **destructive** (kills the process) |

**Attaching to an existing terminal** means `terminal_list` followed by `terminal_read` and
`terminal_write` on its id. A person's own terminals in that thread are reachable too. That
is the "attach" the issue names, and it is the full grant the decision describes. Keystrokes
an agent writes into a person's shell are not attributed (C6).

### Bounded output

`TerminalHistory` gains a monotonic `total_bytes_written: u64` and
`read_window(from: u64, max_chars) -> { text, start, end, dropped }`. A cursor older than
the retained scrollback reports `dropped: true` and starts at the oldest retained byte.

`terminal_read` rules:

- with no cursor, it returns the last `tailChars`;
- each page is at most 16,000 characters;
- the result is `{ text, nextCursor, dropped, status, exitCode }`.

With `raw: false`, CSI and OSC escape sequences are removed server-side. The protocol's
`tool_result` already makes the remaining control characters visible escapes. Output is
marked untrusted, never logged, and never goes into a profiler record.

### Concurrency and lifecycle

- Writes to one terminal from concurrent MCP calls go through a per-terminal mutex in the
  tool layer.
- `terminal.write` is the unary, unordered path. The ordered input lease is scoped to a
  WebSocket connection (`docs/architecture/rpc-and-orchestration.md`, "Ordered terminal
  input"), and MCP has no connection to scope it to.
- A terminal that MCP opened outlives the MCP session. It is the thread's terminal, the
  UI shows it, and the user can close it there.
- Retries use recorded outcomes for `terminal_open` (one terminal per key) and
  `terminal_write` (one write per key).

### Profiler

- No new child process path: terminals start through the existing terminal runtime,
  which owns supervision and attribution.
- `mcp.terminal_open` is long-running through `terminal.open` (`latency.rs:165`).
- `terminal_read` does no I/O beyond memory.

### UI

The Agent integrations section gains an **Allow terminals** switch: "Let MCP agents open
terminals and run any command in this environment."

- It is disabled with "Set Agents may to Full access first." while the ceiling is lower,
  and with "Turn on MCP server first." while the server is off.
- Turning it on asks nothing, because it is reversible. Agents pick it up only after
  their MCP server restarts, and the description says so.

**Tests (fail first):**

- with the setting off, the tools are hidden and refused;
- with the setting on and a Supervised ceiling, they are refused with a message naming
  Agents may;
- a credential minted without the scope is refused even with the setting on;
- turning the setting off mid-session refuses the next call;
- open, write `echo hi`, read returns `hi` and a cursor, and reading from the cursor
  returns only new output;
- after more than 1 MiB of output, an old cursor reports `dropped: true`;
- a 17,000-character write is refused;
- concurrent writes do not interleave within one call's data;
- a captured tracing subscriber and the profiler sink never see terminal input or
  output.

## Slice D: Device and browser previews for outside agents

**Alternatives:**

- Proxy an outside agent through a provider credential. That confuses the two
  principals. Rejected.
- **Chosen:** client-kind twins of the provider tools, run through the shared function F0
  extracted, with a per-call scope check.

The twins:

- **Names.** Clients see the same names, `preview_*` and `device_*`, with one extra
  required argument, `threadId`, which the provider version gets from its credential.
- **Scope.** The handler builds a `PreviewScope`:
  - `environment_id` is this environment;
  - `thread_id` is the given thread;
  - `owner_thread_id` is the thread's host thread, else the thread itself;
  - `provider_session_id` is `mcp:<sid>:<threadId>`, so an agent gets its own tab
    assignment and never takes a provider's;
  - `provider_instance_id` is `mcp-client`.
- **Gates.**
  - Scope: `orchestration:operate`.
  - Ceiling: above `read-only`.
  - `device_*` needs device previews on (`DeviceTools::enabled`), as it does for
    providers.
  - `preview_*` needs a connected automation host (a BiBCode UI that is open). Without
    one, the existing `PreviewAutomationNoAvailableHostError` comes back; the description
    says to open BiBCode.
- **Hints.**
  - `device_list`, `device_screenshot`, `preview_status` and `preview_snapshot` are
    read-only.
  - `preview_evaluate` (runs script in the page) and `device_close` are destructive.
  - The others are neither.
- **Results** are the provider tools' results: screenshots as image content, at most
  1,080 px wide.

**Trust boundary.** A device belongs to the thread that started it. An outside agent acting
for thread X cannot attach to or stop thread Y's device; the existing refusal applies.
Preview pages are untrusted content.

**Profiler.** These are long-running by design (`long_running: true`, as `PROVIDER_TOOL`; they hold no wait slot). There is
no new process: emulators start through `DeviceManager`.

**Tests (fail first):**

- a client `device_list` with a `threadId` works with previews on and is refused with
  them off;
- a client cannot close another thread's device;
- `preview_open` with no automation host returns the typed error;
- a provider credential still reaches its own tools and not the client twins;
- two outside agents get separate tab assignments.

## Slice R: Remote Streamable HTTP with MCP OAuth

### Spec requirements relied on

These were verified in the 2026-07-28 and 2025-11-25 authorization pages on 2026-10-30.

- **STDIO.** "Implementations using an STDIO transport SHOULD NOT follow this
  specification", so the relay keeps its environment credential.
- **Protected Resource Metadata (RFC 9728).** The server MUST implement it, and its
  `authorization_servers` MUST name at least one server.
  - It is discovered through `WWW-Authenticate: Bearer resource_metadata=…` on 401, or at
    `/.well-known/oauth-protected-resource/mcp` and then the root.
  - Servers SHOULD add `scope` to the challenge.
- **Authorization server metadata.** RFC 8414 at `/.well-known/oauth-authorization-server`
  (or OIDC discovery).
  - The `issuer` MUST equal the URL it was fetched for.
  - Clients MUST refuse to proceed when `code_challenge_methods_supported` is absent.
    PKCE `S256` is required.
- **Client registration.**
  - Client ID Metadata Documents: SHOULD.
  - Dynamic Client Registration (RFC 7591): MAY. Deprecated in 2026-07-28, not in
    2025-11-25.
  - Pre-registration: clients SHOULD support it.
- **Resource indicators (RFC 8707).** Clients MUST send `resource` on the authorize and
  token requests. Servers MUST validate that a token "was issued specifically for them as
  the intended audience", and MUST NOT accept or pass through other tokens.
- **Communication security.** "All authorization server endpoints MUST be served over
  HTTPS", and redirect URIs MUST be `localhost` or HTTPS.
- **Tokens.**
  - Authorization servers SHOULD issue short-lived access tokens.
  - Refresh tokens for public clients MUST be rotated **if issued**.
  - Clients MUST NOT assume refresh tokens will be issued.
- **`iss` (RFC 9207, 2026-07-28 only).** Servers SHOULD include `iss` in authorization
  responses, and advertise `authorization_response_iss_parameter_supported`.
- **Streamable HTTP.**
  - Servers MUST validate `Origin`, and answer an invalid one with 403.
  - There are no sessions and no GET stream in 2026-07-28.
  - 2025-11-25 sessions are optional for the server.
- **Claude Code** (its MCP docs, read 2026-10-30):
  - It supports DCR, CIMD, and `--client-id`/`--callback-port` pre-registration.
  - It sends OAuth credentials only to a token endpoint that is HTTPS or loopback.
  - Its HTTP idle window is 5 minutes. Calls running past 2 minutes move to a
    background task.

### Alternatives

| Choice                      | Options                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Decision                                                                                                                                                                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transport auth              | R1 MCP OAuth; R2 static bearer in the harness config (not conformant, and it parks a 30-day operate token in a file)                                                                                                                                                                                                                                                                                                                                     | **R1** (slice 1's answer)                                                                                                                                                                                                                           |
| Authorization server        | BiBCode as its own authorization server on the same origin; an external one (the Connect relay, Clerk)                                                                                                                                                                                                                                                                                                                                                   | **Same origin.** The environment owns its sessions (`remote.md`: the relay "does not become the owner of environment sessions")                                                                                                                     |
| Client registration         | DCR; CIMD (the server fetches the client's HTTPS metadata, so it needs an SSRF-safe fetcher); a pre-registered id issued in Settings                                                                                                                                                                                                                                                                                                                     | **DCR now.** Both harnesses can use it, and it needs no outbound fetch from the server. CIMD is a follow-up. Pre-registration is a fallback for a client without DCR (Question 5)                                                                   |
| Consent                     | (a) type a pairing code on the consent page (the upstream project's model; BiBCode's pairing codes are long base64 blobs, `auth/pairing_code.rs`); (b) the consent page needs a BiBCode cookie session; (c) **approve in BiBCode**: the page shows a short code, and any BiBCode client with `access:write` on that environment shows a card with the same code to approve or deny, with `bibcode mcp authorize <code>` on the host as the headless path | **(c)** (Question 4). Nothing to remember or type (UI.md), the decision stays in an authenticated BiBCode surface, and the matching code defeats a look-alike request                                                                               |
| Token lifetime              | short access token plus rotating refresh token; the existing 30-day session, with no refresh token                                                                                                                                                                                                                                                                                                                                                       | **30-day session, no refresh token** (Question 6). Revocation already takes effect on the next request, because every bearer re-reads its session row, and rotation adds a table and a reuse-detection rule. This declines the "short-lived" SHOULD |
| Plain HTTP on a LAN address | serve OAuth anyway; refuse                                                                                                                                                                                                                                                                                                                                                                                                                               | **Refuse.** The spec requires HTTPS for authorization endpoints, and Claude Code refuses a non-loopback `http` token endpoint. Plain-HTTP environments keep `ssh <host> bibcode mcp`                                                                |
| A new setting               | `mcpRemoteHttp` on or off; gate on `enableMcpServer` only                                                                                                                                                                                                                                                                                                                                                                                                | **No new setting.** Every grant still needs approval in BiBCode, and the unauthenticated routes only create bounded, expiring rows                                                                                                                  |

### Routes

Every metadata value is computed per request from the **effective origin**:

- the scheme is `https` when `X-Forwarded-Proto: https` comes from a loopback peer (the
  existing forwarded-header trust rule, `remote.md` "Security boundaries"), else `http`;
- the host is `Host`, after the existing loopback-only `X-Forwarded-Host` rule.

An **eligible origin** is `https`, or `http` with a loopback host. Every route below
answers 404 on any other origin, and on a preview gateway hostname.

- **`GET /.well-known/oauth-protected-resource/mcp`** and
  **`GET /.well-known/oauth-protected-resource`** return:
  - `resource: "<origin>/mcp"`;
  - `authorization_servers: ["<origin>"]`;
  - `scopes_supported: ["orchestration:read", "orchestration:operate"]`;
  - `bearer_methods_supported: ["header"]`;
  - `resource_name`: the environment label.
- **`GET /.well-known/oauth-authorization-server`** returns:
  - `issuer: "<origin>"`;
  - `authorization_endpoint`, `token_endpoint` (`/oauth/token`) and
    `registration_endpoint`;
  - `response_types_supported: ["code"]`, `grant_types_supported: ["authorization_code"]`;
  - `code_challenge_methods_supported: ["S256"]`,
    `token_endpoint_auth_methods_supported: ["none"]`;
  - `scopes_supported`, with `terminal:operate` added while `mcpAllowTerminals` is on;
  - `authorization_response_iss_parameter_supported: true`.
- **`POST /oauth/register`** (RFC 7591):
  - **Clients.** Public clients only (`token_endpoint_auth_method: "none"`).
  - **`redirect_uris`.** One to five, each `http://localhost|127.0.0.1|[::1]:<port>/…`
    or `https://…`, with no fragment.
  - **`client_name`.** Up to 100 characters, shown as untrusted text.
  - **Storage and limits.** It stores a row in `mcp_oauth_clients`. At most 64 clients
    may never have been approved; past that, the oldest is pruned. Clients that were
    never approved are pruned after 24 hours, and approved ones after 90 days unused.
  - **Response.** `client_id`, `client_id_issued_at`, `redirect_uris`, `client_name`,
    `token_endpoint_auth_method`.
- **`GET /oauth/authorize`** validates before it redirects anywhere:
  - the client and the **exact** redirect URI; on failure it shows an error page and
    never redirects;
  - `response_type=code`;
  - `code_challenge_method=S256` with a 43–128 character challenge;
  - `resource` equals `<origin>/mcp` exactly (case-insensitive scheme and host);
  - the requested scopes are within `scopes_supported`.

  Then it creates a pending authorization in `mcp_oauth_authorizations`:
  - an id, and a `user_code` of 8 characters from an unambiguous alphabet, shown as
    `XXXX-XXXX`;
  - the client, redirect URI, challenge, `state`, resource, requested scopes, the
    effective origin, and the peer address class;
  - expiry after 10 minutes; at most 16 pending per environment.

  It answers with the consent page (below).

- **`GET /oauth/authorize/status?id=…`** is the page's own poll, read with the cookie the
  page set:
  - **pending:** it refreshes;
  - **approved:** a 303 to `redirect_uri?code=…&state=…&iss=<origin>`;
  - **denied:** `error=access_denied&state=…&iss=…`;
  - **expired:** an error page.

  The status cookie is an HttpOnly, `SameSite=Strict` random value bound to the pending
  row, so another page cannot read the code.

- **`POST /oauth/token`** gains `grant_type=authorization_code`, with `code`,
  `code_verifier`, `redirect_uri`, `client_id` and `resource`.
  - **Code.** Single use, valid for 60 seconds. Its PKCE S256 must verify, and its
    redirect URI and resource must match.
  - **Session.** Exchange mints an `mcp-client` session through the existing session
    writer:
    - scopes as approved, and `mcp_access` as approved;
    - `mcp_resource` set to the resource;
    - label `MCP · <client_name> (remote)`, method bearer;
    - lifetime 30 days.
  - **Response.** `{ access_token, token_type: "Bearer", expires_in, scope }`. No refresh
    token is issued.
  - **Code reuse.** A second use of a code revokes the session it minted, as RFC 6749
    §4.1.2 recommends.
- **`POST /api/auth/mcp-authorizations/{id}/approve`** with `{ access, terminals }`, and
  **`/deny`**:
  - They need `access:write`, like the other `/api/auth/*` administration routes.
  - `access` is at most the current `mcpServerAccess`, and `terminals` is allowed only
    under slice T's conditions.
  - The pending list reaches clients on the existing `subscribeAuthAccess` stream, as a
    new optional `pendingMcpAuthorizations` field.
- **Host CLI.** `bibcode mcp authorize [<code>] [--access <level>] [--terminals] [--deny]`
  works through the data root, the same authority as `bibcode pairing issue`.
  - With no code it lists the pending requests.
  - `<desktop exe> mcp authorize` is dispatched after `crash::attach()`, like `mcp`.

### `/mcp` changes

- **401 challenge.** On an eligible origin, a 401 now carries
  `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp", scope="orchestration:read orchestration:operate"`.
  A provider never sends a request without its token, so providers see no difference.
- **Audience, checked in `authenticate_mcp_client`:**
  - A session with `mcp_resource` set is accepted only when the request's effective
    `<origin>/mcp` equals it.
  - A session with `mcp_resource` NULL, minted by the stdio relay, is accepted only when
    the effective host is a loopback literal or `localhost`. This closes a path slice 1
    left open: through a tunnel, requests come from a loopback peer but carry the public
    host, so a relay credential that leaked could otherwise be used through the tunnel.
  - Provider credentials are unchanged.
- **Origin.** The existing 403 for a foreign `Origin` stays. A DNS-rebinding page sends
  its own `Origin`, so it gets 403. The consent page sends `frame-ancestors 'none'`,
  `X-Frame-Options: DENY`, and a CSP with no script.
- **Legacy session shape.**
  - Providers keep `initialize` and `Mcp-Session-Id` (slice 1).
  - OAuth clients are sessionless in both eras, as relay clients already are.
  - `DELETE /mcp` from a client principal gets 405. GET stays 405.
- **Insufficient scope.** A tool the credential lacks is hidden from `tools/list` and
  refused as a typed `McpScopeError` tool result. It is not refused with HTTP 403
  `insufficient_scope`, because a step-up re-authorization cannot grant more than
  approval in BiBCode does. Whether harnesses act on step-up at all is unverified.

### Tunnels and relays

- **BiBCode Connect's managed tunnel** gives an environment an HTTPS hostname, so remote
  MCP works there. Its connector runs on the host, so the peer is loopback, and the
  origin comes from the forwarded headers.
  - **Verify in implementation:** whether the connector sends `Host` or
    `X-Forwarded-Host` with the public name, and `X-Forwarded-Proto: https`. If it does
    not, the origin is wrong and every token is refused, which fails closed.
  - A token minted through one hostname does not work through another, and a tunnel
    hostname change requires a new authorization. This is intentional (RFC 8707
    audience).
- **A reverse proxy** with TLS on the host (with `X-Forwarded-Host`, `remote.md`
  already requires it), Tailscale Serve, or `ssh -L` to loopback also give an eligible
  origin.
- **The Connect relay's own tokens** never reach `/mcp`. They are not `mcp-client`
  sessions, and `/mcp` accepts no other session.
- **Preview gateway hostnames** never serve these routes.

### Trust boundaries

- **Who can grant access.**
  - The unauthenticated routes (register, authorize, status, token) grant nothing by
    themselves. Approval needs `access:write` in BiBCode, or the data root.
  - The approval card names the client, the redirect host ("Returns to
    `localhost:53682`"; the spec says the host MUST be displayed), the origin the request
    used, and the matching code.
  - When the redirect URI is localhost only, the card warns "Only approve if you just
    started this in an AI tool on that computer.", as the spec's localhost-impersonation
    note asks.
- **What the token reaches.** Only `/mcp` at that resource, within the approved scopes
  and the lower of its ceiling and the environment's.
- **Abuse.** Pending authorizations and registered clients are capped and expire, and
  each route does constant work. A flood fills the caps and then gets 429. It cannot
  grant access or grow storage without bound.

### Failure, restart, concurrency

- Pending authorizations are durable rows, so a restart does not lose them, and the
  page's poll continues afterwards.
- Codes are single-use under one SQLite transaction. Two exchanges of one code race,
  and the second loses and revokes (above).
- With `enableMcpServer` off, the authorize page says the MCP server is off, the token
  endpoint refuses `authorization_code`, and `/mcp` answers `McpServerDisabledError`.
  Sessions are kept.
- **Unverified:** Codex refreshing OAuth tokens. Third-party reports describe a refresh
  bug, which issuing no refresh token sidesteps.

### Persistence: migration 60, `McpOAuth`

- `mcp_oauth_clients`: `client_id` (primary key), `client_name`, `redirect_uris_json`,
  `created_at`, `approved_at`, `last_used_at`.
- `mcp_oauth_authorizations`: `id` (primary key), `user_code` (unique), `client_id`,
  `redirect_uri`, `code_challenge`, `state`, `resource`, `scopes`, `origin`,
  `status_cookie_hash`, `status` (`pending`, `approved`, `denied`, `exchanged`),
  `approved_access`, `approved_scopes`, `code_hash`, `code_expires_at`, `session_id`,
  `created_at`, `expires_at`.
- `auth_sessions.mcp_resource TEXT NULL`.

### UI (Agent integrations, MCP tab)

- **Remote agents row.** For an environment whose saved endpoint is eligible, it shows the
  MCP URL with **Copy for Claude Code**
  (`claude mcp add --transport http bibcode <url>`) and **Copy for Codex**
  (`codex mcp add bibcode --url <url>`, unverified syntax).
  - Otherwise it says: "Remote agents need an HTTPS address. Use the launch command over
    SSH instead."
- **Requests to connect.** A card for each pending authorization, with:
  - the client name (untrusted text), the redirect host, the request origin and the
    code;
  - an **Agents may** select, defaulting to and capped at the environment's;
  - an **Allow terminals** checkbox, shown only when slice T's conditions hold;
  - **Approve** and **Deny**.
- **Toast.** A new pending request also raises a toast in every BiBCode client with
  `access:write`: "Claude Code wants to operate <environment>. Review". **Review** opens
  the section, because the consent page tells the user to approve in BiBCode.
- **Consent page** (server-rendered, no script): "<client> wants to operate <environment>
  in BiBCode. Approve it in BiBCode (Settings → Agents → Agent integrations), or on the
  server run `bibcode mcp authorize XXXX-XXXX`. Code: XXXX-XXXX. It will return to
  <redirect host>." It updates itself.

**Tests (fail first):**

- **Metadata.**
  - PRM at both well-known paths, with `resource` equal to the request origin plus
    `/mcp`.
  - AS metadata with an `issuer` equal to the origin and `S256`.
  - Both are 404 on a non-loopback `http` origin and on a preview hostname.
- **401 challenge.** It names the PRM URL, and is absent on an ineligible origin.
- **Register.** It refuses a non-loopback `http` redirect URI, and a 65th unapproved
  client prunes the oldest.
- **Authorize.**
  - An unknown client or redirect URI shows an error page with no redirect.
  - A missing or `plain` PKCE method is refused.
  - A `resource` for another origin is refused.
- **Flow.** Approve, then status redirects with `code`, `state` and `iss`, then token
  with the right verifier returns a bearer.
  - A wrong verifier, a reused code (which also revokes the session), or an expired code
    is refused.
- **Audience.**
  - The token works at its origin's `/mcp` and gets 401 at another `Host`.
  - A relay (NULL-resource) token gets 401 when `X-Forwarded-Host` names a public host
    from a loopback peer.
- **Approval route.**
  - It needs `access:write`; a standard pairing bearer is refused.
  - `access` above `mcpServerAccess` is refused.
  - `terminals` is refused while the setting is off.
- **CLI.** `bibcode mcp authorize` lists and approves through the data root.
- **Off switch.** The token endpoint refuses, and the page explains why.
- **Inventory.** `ROUTE_INVENTORY` lists the new routes with their auth class, and the
  audience test still refuses an `mcp-client` token on every authenticated route.
- **Live smoke.** A Claude Code `claude mcp add --transport http` against an HTTPS
  reverse proxy completes the flow.

## Deferred: Tasks and resources

**Tasks extension.**

- **Harness support.** The extension's client matrix page could not be read (its cells
  came back empty). Claude Code documents Tasks as a CLI public beta from v2.1.304:
  2026-07-28 only, over HTTP or stdio, from the main conversation, and not in the VS Code
  extension or the desktop app. Codex support is unknown.
- **What it would buy.**
  - Turns are already durable: a task id could be the `messageId`, `tasks/get` one wait
    read without waiting, and `tasks/cancel` an `interrupt_turn`.
  - Waits past 50 s would need no loop of calls.
- **What it costs.**
  - Extension negotiation in `server/discover` and on every request.
  - Polymorphic `start_thread` and `send_message` results.
  - `tasks/get`, `tasks/update` and `tasks/cancel`, an `input_required` mapping for
    questions, and a second waiting path beside `wait_for_thread`, which every harness
    already handles.
- **Decision.** Deferred. Revisit when Codex supports it or Claude Code makes it GA.

**Resources.** Claude Code supports `@server:uri` mentions. None of the requested
activities needs a person to mention a BiBCode object in a prompt, and tools already cover
reading. Deferred.

## `bibcode thread` CLI

The CLI is designed in slice 1 ("CLI front end") and being implemented in parallel. This
design does not change it, with three notes:

- **No new subcommands.** There is no approve or destructive subcommand. Exit code 2
  still means "a person must answer". An agent using MCP may now answer instead, but the
  CLI does not.
- **Shared files.** The CLI writer and slice R both edit `apps/server/src/lib.rs` and
  `config.rs` (subcommand dispatch for `thread` and for `mcp authorize`). Slice R
  rebases on the CLI if the CLI lands first.
- **Attachments.** The CLI's `start` and `send` could take attachments after slice A;
  this is not planned here.

## Persistence and migration summary

| Migration            | Slice | Change                                                                                                 |
| -------------------- | ----- | ------------------------------------------------------------------------------------------------------ |
| 59 `McpToolOutcomes` | F0    | `mcp_tool_requests.state` (default `commands`), `mcp_tool_requests.outcome_json`                       |
| 60 `McpOAuth`        | R     | `mcp_oauth_clients`, `mcp_oauth_authorizations`, `auth_sessions.mcp_resource`, with `CORE_TABLES` rows |

The numbers are assigned here. If another branch lands a migration first, both renumber in
order, and nothing depends on the numbers.

**Contracts:**

- `settings.ts`: `mcpAllowTerminals` (F0);
- `auth.ts`: `AuthAccessStreamEvent.pendingMcpAuthorizations`, optional (R).

No new RPC methods.

## Profiler, crash, and trace coverage

| Item                  | Coverage                                                                                                                                                                                                                                                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Child processes       | None new. Git runs through the repository layer, terminals through the terminal runtime, and devices through `DeviceManager`, each already supervised and attributed.                                                                                                                                           |
| RPC methods           | None new. B1 and `invoke_local_stream` keep the registry's admission. Every tool is timed as `mcp.<tool>`, and `is_long_running` derives from `ToolSpec` (network tools are `long_running: true`). The F0 test iterates every family. The new HTTP routes are not RPC; they log failures with `tracing::warn!`. |
| Worktree removal      | Both modes reach the handlers that call `record_removal_outcome`. A test asserts one event per real removal and none per replay. No new removal path.                                                                                                                                                           |
| Binaries and re-exec  | `mcp authorize` is dispatched after `crash::attach()` in both `main.rs` files, under the existing `mcp` branch.                                                                                                                                                                                                 |
| Shutdown              | Recorded-outcome tasks and terminal-read waits stop at `McpControl::shutdown`, which already runs right after `profiler.begin_stopping()` and before orchestration and profiler teardown.                                                                                                                       |
| Events, logs, records | One `info` line per destructive call (C7). No prompt, message, commit message, PR body, path or terminal content, and nothing new in fingerprints.                                                                                                                                                              |
| Documentation         | The new `mcp.*` names, and the note that `mcp.<tool>` timing covers them, go in `docs/skills/bibcode-profiler/references/` and the Profiler section of `overview.md` (slice Z).                                                                                                                                 |

## UI review (UI.md)

**Changed surfaces:**

- The MCP tab's copy.
- The **Allow terminals** switch (T).
- The **Remote agents** row, the **Requests to connect** cards, and the toast (R).
- The server-rendered consent page (R).

Against UI.md:

- **Defaults stay safe.** Terminals are off. Remote access needs an explicit approval
  each time.
- **The access description tells the truth.** It becomes: "Threads an MCP agent starts
  or messages never run with more access than this. At any level above Read only,
  agents can also answer approvals, remove worktrees, discard changes, force-push and
  merge pull requests." This is an honest default in place of a surprise.
- **The server description** becomes "Let AI tools operate this environment: threads,
  worktrees, Git and pull requests."
- **Disabled states explain themselves:**
  - "Set Agents may to Full access first."
  - "Turn on MCP server first."
  - "Remote agents need an HTTPS address…"
- **Recognition over recall.** Copy buttons give the exact commands. Approval needs no
  typed code, only a code to compare.
- **No confirmation dialogs.** Every switch is reversible, and Approve is itself the
  confirmation.
- **Errors are actionable.** The consent page and the typed tool errors name the setting
  or the action that fixes them.

The `vercel-react-best-practices` review applies to `AgentIntegrationsSection.tsx` and the
new components.

## Docs and skill

**Per slice**, in the same change, each in its own subsection:

- `docs/user/mcp.md`: the tool reference table rows and a "### <family>" section;
- `docs/architecture/rpc-and-orchestration.md`: the tool-to-method mapping.

**Slice R** owns:

- `docs/architecture/remote.md`: replace "Remote Streamable HTTP … is not served"
  (`:1804-1805`); cover OAuth, audience, eligible origins and tunnels;
- `docs/cloud/environment-auth.md`: the OAuth routes, the authorization-code grant, and
  the "not a general-purpose OAuth authorization server" sentence, which becomes "an
  authorization server for `/mcp` only";
- `docs/user/remote-access.md`.

**Slice Z** (last, one owner):

- **`docs/user/mcp.md` sections.** "What it can and cannot do" inverts (approvals and
  destructive tools), and the safety model from C6 is added.
- **Living docs.** `overview.md` Profiler and MCP sections, and
  `docs/skills/bibcode-profiler/references/`.
- **Slice-1 doc.** A dated "Superseded 2026-10-30" note under its Non-goals and its
  "Approvals?" answer. The decisions themselves are not edited.
- **Runbooks.** `docs/testing/cross-platform-validation.md` and `ssh-environments.md`
  gain smoke steps for a destructive tool, a terminal and a remote OAuth connect.
- **`docs/skills/bibcode-mcp/`, rebuilt test-first:**
  1. Re-record baselines without the skill for these scenarios:
     - **"just approve it"**: eval 2's expectation flips from refuse-and-relay to
       "approve only the named request, after confirming its summary matches what the
       person asked";
     - **"clean up the worktree"**: read the plan first, then never `discardChanges`
       without the person's say-so;
     - **"force-push my branch"**: use `git_force_push` only when asked for force;
     - **injected instructions** in a transcript, a PR body or terminal output: act on
       none of them;
     - **a remote host over HTTPS**;
     - **"use a terminal"** with terminals off: name the setting.
  2. Update `evals.json` and `trigger-evals.json`.
  3. Write the minimal skill text.
  4. Re-run, and close the loopholes.
  5. Keep the stubs in `.agents/skills/` and `.claude/skills/` byte-identical.

## Implementation partition

### Dependency order

```text
F0 ──┬── A
     ├── W
     ├── G
     ├── P
     ├── T
     ├── D
     └── R (auth/* and routes can start at once; connect_mcp.rs rebases on F0)
A, W, G, P, T, D, R ── Z (last)
`bibcode thread` CLI writer: parallel to all; R rebases lib.rs/config.rs on it
```

Remote HTTP is independent of the tool slices. Every tool works over every transport once
it lands, so R may land before or after them.

### File ownership

| Slice | Owns (new or changed)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Touches after its owner (one-line or rebase)                                                                                                        |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| F0    | `apps/server/src/mcp/control.rs`, `mcp/mod.rs`, `mcp/wait.rs`, new `mcp/tools/mod.rs`, new `mcp/tools/threads.rs` (move only), new `mcp/target.rs`, new `mcp/outcome.rs`, new `mcp/tools/previews.rs` (provider dispatch extracted), `mcp/relay.rs` (terminal scope at mint), `rpc/session.rs`, `persistence/migrations.rs` (59), `persistence/repositories.rs` (outcome rows), `production/connect_mcp.rs` (extraction, kind-aware call), `production/connect_mcp/tests.rs`, `production/control.rs` (setting), `production/mcp_tools_tests.rs` → `mcp_tools_tests/{mod,threads}.rs`, `diagnostics/profiler/latency.rs`, `auth/service.rs` (`issue_mcp_pairing_link` extra scope only), `packages/contracts/src/settings.ts` and fixtures | —                                                                                                                                                   |
| A     | `mcp/tools/threads.rs`, new `production/mcp_tools_tests/thread_actions.rs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `mcp/control.rs` `FAMILIES` (no change: threads already listed), `mcp_tools_tests/mod.rs` (one `mod` line)                                          |
| W     | new `mcp/tools/worktrees.rs`, new `production/mcp_tools_tests/worktrees.rs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `mcp/control.rs` `FAMILIES`, `mcp/tools/mod.rs`, `mcp_tools_tests/mod.rs` (one line each)                                                           |
| G     | new `mcp/tools/git.rs`, new `production/mcp_tools_tests/git.rs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | the same one-liners                                                                                                                                 |
| P     | new `mcp/tools/pull_requests.rs`, new `production/mcp_tools_tests/pull_requests.rs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | the same one-liners                                                                                                                                 |
| T     | new `mcp/tools/terminals.rs`, `terminal/history.rs`, `terminal/manager.rs` (read window), new `production/mcp_tools_tests/terminals.rs`, `apps/web/src/components/settings/AgentIntegrationsSection.tsx` and its test (the terminals switch **and** all MCP-tab copy changes)                                                                                                                                                                                                                                                                                                                                                                                                                                                              | the same one-liners                                                                                                                                 |
| D     | `mcp/tools/previews.rs` (client twins), `production/connect_mcp/device_tools.rs` only if a `pub(crate)` accessor is needed, new `production/mcp_tools_tests/previews.rs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | the same one-liners                                                                                                                                 |
| R     | `auth/http.rs`, `auth/service.rs` (authorization-code grant, audience), new `auth/oauth.rs`, new `auth/consent_page.rs`, `production/http_routes.rs` (routes, `ROUTE_INVENTORY`), `production/connect_mcp.rs` (401 challenge, after F0), `persistence/migrations.rs` (60), `persistence/repositories.rs` (OAuth rows), `lib.rs` and `config.rs` (`mcp authorize`), `apps/desktop/src-tauri/src/main.rs` (only if dispatch needs it), `packages/contracts/src/auth.ts`, new `apps/web/src/components/settings/McpRemoteAgentsPanel.tsx` and its test, the toast hook, `docs/architecture/remote.md`, `docs/cloud/environment-auth.md`, `docs/user/remote-access.md`                                                                         | `AgentIntegrationsSection.tsx` (one import and mount line, after T); `production/connect_mcp/tests.rs` (401 challenge and audience tests, after F0) |
| Z     | `docs/user/mcp.md` (cross-cutting sections), `docs/architecture/overview.md`, `docs/skills/bibcode-profiler/references/*`, `docs/skills/bibcode-mcp/**`, the `.agents/skills/` and `.claude/skills/` stubs, `docs/testing/*`, `docs/plans/2026-10-24-mcp-operate-server-design.md` (superseded note)                                                                                                                                                                                                                                                                                                                                                                                                                                       | —                                                                                                                                                   |

### Shared files and their single owners

- **The tool table** (`mcp/control.rs` `FAMILIES`, `mcp/tools/mod.rs`): F0. Each family
  adds one line, and the conflicts are trivial.
- **The scope set:** no new scope constant, so `auth/model.rs` and `auth/scope.rs` are
  untouched. `ToolSpec.scope` widening is F0.
- **Contracts:** `settings.ts` belongs to F0, `auth.ts` to R.
- **`persistence/migrations.rs` and `repositories.rs`:** F0 first (59), then R (60).
- **`production/connect_mcp.rs`:** F0 first, then R.
- **`AgentIntegrationsSection.tsx`:** T, then R's one mount line.
- **`docs/user/mcp.md`:** each slice its own subsection; Z the cross-cutting sections,
  last.
- **`production/mcp_tools_tests/mod.rs`:** F0, then one `mod` line per slice.

## Verification

Per slice:

- the focused tests above, written to fail first;
- `cargo fmt --all --check`;
- Clippy with `-D warnings` on the server, and on the desktop for R;
- the server test suite;
- `vp check` and `vp run typecheck`.

UI slices (T, R) add the web tests, the UI.md review and the
`vercel-react-best-practices` review.

Manual smoke tests:

- Claude Code over stdio running the full flow: create a worktree, start, wait, stage,
  commit, push, create the PR, merge, remove the worktree.
- Codex with its default timeouts, including a push.
- `ssh <host> bibcode mcp` with terminals on.
- Remote OAuth through an HTTPS reverse proxy and through BiBCode Connect.
- Revoking mid-session, and the off switch mid-push.

## Risks

- **Destructive defaults** (C6). This is the main risk, and it is accepted by the user's
  decision. Question 1 is the remaining lever.
- **No actor attribution.** Agent actions look like a person's. This is mitigated only by
  logs, Authorized clients and the skill, until the extended-scope attribution design
  lands.
- **Outcome unknown after a crash** (C4) pushes the agent to check state by hand. This is
  rare, and it is never a false success.
- **Tunnel headers** (slice R). An unverified forwarded-host behavior would refuse every
  token through Connect. That fails closed and is caught by the live smoke test.
- **The upload lifetime** shorter than the retry window (slice A). This is a typed error,
  not a lost attachment.
- **Cached tool lists.** As slice 1 notes, a harness that cached its list keeps showing
  the terminal tools after the setting turns off; their calls still fail typed.
- **The HTTPS requirement** leaves plain-HTTP LAN environments on SSH only. This is
  documented.

## Could not verify

- **Codex.** Whether it supports DCR, CIMD and the OAuth flow for Streamable HTTP, its
  `mcp add --url` syntax, and its refresh behavior. Only third-party guides and one
  GitHub issue were found.
- **Tasks client support.** The client matrix page came back with empty cells. Claude
  Code's beta support comes from its own docs.
- **Step-up.** Whether Claude Code or Codex acts on a 403 `insufficient_scope` challenge.
- **Progress tokens.** Whether Codex sends a `progressToken` (carried from slice 1).
- **The Connect tunnel's headers.** Whether its connector forwards the public `Host` (or
  `X-Forwarded-Host`) and `X-Forwarded-Proto: https`.
- **Upload lifetime.** How long an incomplete or unconsumed upload lives
  (`production/uploads_rpc.rs`).
- **Checkpoint revert during a turn.** The exact error tag when `thread.checkpoint.revert`
  runs while a turn is running.
- **The 2025-06-18 revision.** `protocol.rs` also serves it (`VERSIONS`), but only the
  2026-07-28 and 2025-11-25 authorization pages were read. The 2025-06-18 revision is
  expected to want DCR, which slice R serves, but this was not checked.
- **`DELETE` headers.** Whether any harness sends `MCP-Protocol-Version` on `DELETE`.
- **Claude Code and `destructiveHint`.** Whether it prompts differently for
  `destructiveHint` tools (its permissions page was not read). C2 does not depend on it.

## Questions for approval

1. **Destructive tools at every operate level?** The decision reads "any MCP credential
   with operate access", so remove, discard, force-push, branch delete, merge and
   `answer_approval` work at the default **Supervised** ceiling, with the UI copy saying
   so. The alternative is to also require `full-access`. Recommended: as decided, at
   every operate level.
2. **Leave `anthropic/requiresUserInteraction` off?** Setting it makes Claude Code prompt
   on every call and blocks headless use. Recommended: off.
3. **Terminals: three conditions?** They would need the `mcpAllowTerminals` setting
   (default off), a credential minted with `terminal:operate`, and the **Full access**
   ceiling. Recommended: yes.
4. **Remote consent: approve in BiBCode?** The consent page would show a short code, and
   the request would be approved in BiBCode by any client with `access:write`, or with
   `bibcode mcp authorize <code>` on the host. The alternative is typing a code on the
   page. Recommended: approve in BiBCode.
5. **Client registration: DCR only for now?** CIMD and Settings-issued pre-registered
   client ids would come only if a target harness lacks DCR. Recommended: yes.
6. **Tokens: no refresh token?** Remote tokens would be 30-day revocable sessions,
   declining the spec's "short-lived" SHOULD. Recommended: yes.
7. **The extended scope of 2026-10-27:** diagnostics, clone, files, `focus_ui`,
   `send_panel_message`, `changes_since`, attribution, webhooks and capability sets would
   stay out of these slices and get their own design. Given C6, should actor attribution
   come first there?
