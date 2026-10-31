# MCP for Outside Agents: Remaining Slices

Status: Approved 2026-10-30 (user pre-approval; reviewed by Codex and the advisor), every
slice. X2, X5, X6, X8 and R are approved with the Revision 4 requirements below, which
override their sections where they differ. Issue #139. Extends the approved slice-1 design
(`docs/plans/2026-10-24-mcp-operate-server-design.md`, "slice 1" below) and does not
replace it. Verified at `ba143353d4` (`origin/claude/issue-batch-after-v0.13.0`, draft
PR #213). Line references are to that commit.

## Revision 4 (2026-10-30)

The Codex re-review of Revision 3 confirmed X5's transfer binding, X2's removal of raw
logs, X6's clone owner and R's strict refresh reuse. It found one P1 and four P2s, each
with a concrete fix. They are requirements on the writer of each slice, with a
failing-first test each, rather than another design round:

| Slice | Finding                                                                                                                                                                                | Requirement                                                                                                                                                                                          |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R     | P1: the session-token verifier rejects a token whose `exp` differs from the stored expiry (`auth/service.rs:917`, `:952`), so a one-hour access token on a 30-day grant fails at once. | Check the grant's expiry and the access token's expiry separately. Test an immediate `/mcp` call after the exchange and a call after refresh.                                                        |
| X6    | P2: a public repository's `.lfsconfig` `lfs.url` makes the checkout's LFS smudge filter download from another host, outside Git's protocol and curl settings.                          | Agent clones run with LFS smudge disabled (`GIT_LFS_SKIP_SMUDGE=1` and `-c filter.lfs.smudge= -c filter.lfs.process= -c filter.lfs.required=false`). Test a private LFS endpoint is never contacted. |
| X6    | P2: SSH resolves the host again after the check, so DNS can move it to a private address that presents a trusted key.                                                                  | Refuse SSH for agent clones in this slice; agents clone over HTTPS, which is pinned. Record pinned SSH as a follow-up.                                                                               |
| X2    | P2: a rejected `git.runStackedAction` records its client-supplied `action` text in the profiler event (`diagnostics/profiler/git_actions.rs:105`), which `profiler_events` returns.    | Record only a known action name, or `unknown`, and allowlist profiler event fields returned over MCP. Test a rejected-action marker never appears.                                                   |
| X8    | P2: `profiler_findings` clamps to 100 newest-first (`diagnostics/profiler/mcp.rs:31`, `:295`), so a gap over 100 findings cannot be caught up.                                         | Add a cursor to `profiler_findings` (oldest-first from `since`, with `nextCursor`). Test a gap of more than 100 findings.                                                                            |

**Agent-facing reference (user request, 2026-10-30).** Slice Z also writes the complete
MCP and webhook reference in `docs/` so another AI can operate BiBCode from it alone,
written from the finished code, not this design:

- `docs/reference/mcp.md`: how to connect over each transport (stdio `bibcode mcp`, the
  desktop executable, `ssh <host> bibcode mcp`, remote HTTP with OAuth, `bibcode thread`);
  protocol eras; access levels and capability sets; then every tool with its arguments,
  result shape, errors, annotations, required access and capability, idempotency and
  `clientRequestId` rules, pagination and size caps, wait and progress semantics, and a
  worked call for each family; and the safety model, including destructive tools.
- `docs/reference/webhooks.md`: enabling and registering, every event with its payload
  schema, signature verification with a worked example, retries, auto-disable, and
  catch-up through `changes_since` and `profiler_findings`.
- Both are linked from `docs/README.md` and the `bibcode-mcp` skill, and a test fails when
  a registered tool or webhook event is missing from them.

## Revision 3 (2026-10-30)

This revision answers the Codex re-review of Revision 2. It changes only X2, X5, X6, X8
and R, and the file ownership rows they need; F0 and the other slices are approved and
unchanged. Every finding was checked against the source at `ba143353d4` before it was
accepted. None was refuted.

| #   | Finding                                                                                                                                                                          | Resolution                                                                                                                                                                                                                                                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | X5: a transfer URL is trusted on its signed token alone (`production/transfer_routes.rs:155`), so it outlives Stop, revocation, read-only and MCP off                            | **Accepted (X5).** An MCP-minted token names its session. The route checks that session and the live controls when the transfer starts, runs it under C4's cancellation token, and checks again just before the upload's final rename. An ended access removes the partial file and answers as an expired token. UI tokens are unchanged ([X5](#slice-x5-workspace-files)) |
| P2  | X2: `redact_sensitive_text` blanks credentials only (`diagnostics/trace.rs:474`, `:527`), and provider output lines are logged verbatim (`production/provider_runtime.rs:19265`) | **Accepted (X2).** `get_server_logs` is dropped. Process and trace tools return an allowlisted projection, never a command line, `cause` or message text. Content is kept out by projection, not by redaction ([X2](#slice-x2-diagnostics-tools))                                                                                                                          |
| P2  | X6: a detached clone keeps running after the call (`production/clone_operations.rs:5-6`, `:288`), and nothing owns the later `project.create`                                    | **Accepted (X6).** The clone and its registration run as one C4 owned mutation, under the live controls. The recorded request, with its frozen `projectId` and `commandId`, is the durable registration intent ([X6](#slice-x6-clone))                                                                                                                                     |
| P2  | X6: an operate client can make the server clone from loopback or private hosts (`git/repository.rs:7376`)                                                                        | **Accepted (X6).** Public hosts only, checked after Git's own URL rewriting, with the HTTPS address pinned and redirects refused. The UI's clone is unchanged ([X6](#slice-x6-clone))                                                                                                                                                                                      |
| P2  | R: returning the new pair to a replay of the old refresh token within 60 seconds hides a theft                                                                                   | **Accepted (R).** A refresh token works once. A second use is refused and revokes the grant. The 60-second grace is gone: Codex serializes its refreshes across processes and rereads the stored token under a lock, so it never replays one ([R](#slice-r-remote-streamable-http-with-mcp-oauth))                                                                         |
| P2  | X8: `profiler.finding` has no catch-up path, since `changes_since` reads only events and activity rows                                                                           | **Accepted (X8).** A finding payload carries the finding's id, count and `lastSeen`, and a receiver catches up with X2's `profiler_findings { since }`, which is inclusive. X3 is unchanged ([X8](#slice-x8-outbound-webhooks-and-the-agent-integrations-tabs))                                                                                                            |

**Also changed:**

- **Question 8 is resolved:** an agent clones only next to a registered project, with no
  new allow-list setting.
- Lines outside the five slices that the fixes made stale are corrected: X2's summary in
  [In scope](#in-scope) (no server logs), the Profiler table's "log tools", the "Refresh
  races" risk, Question 8, and one new
  [Could not verify](#could-not-verify) entry (Claude Code refreshing from two processes).
- The wave order is unchanged. Only file ownership grows: X5 adds `production/runtime.rs`
  and an accessor in `mcp/outcome.rs`, and X6 adds `git/repository.rs` and
  `production/git_vcs.rs`, each after its earlier owner (see
  [Shared files](#shared-files-and-their-owners-in-order)).

## Revision 2 (2026-10-30)

This revision answers the Codex design review, the advisor's additions, and the user's
answers to the seven questions. Every finding below was checked against the source before
it was accepted. None was refuted.

| #   | Finding                                                                                                           | Resolution                                                                                                                                                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | The off switch does not stop detached writes: `McpControl::call` reads `enabled` once (`mcp/control.rs:428`)      | **Accepted (F0).** An owned mutation observes the live off switch, read-only and revocation. It holds its admission until it settles, and an interruption records `unknown`, never success ([C4](#c4-retries-for-rpcs-without-receipts))      |
| P2  | Provider and relay bearers have no audience; `X-Forwarded-Host` is trusted from any loopback peer (`http.rs:191`) | **Accepted (R).** Provider and relay bearers are accepted only on a direct local request. The forwarded-header rule is narrowed so a client value can no longer replace `Host` through the tunnel ([Origins](#origins-and-forwarded-headers)) |
| P2  | Remote OAuth still issues a 30-day bearer                                                                         | **Accepted (R).** One-hour access tokens and a rotating refresh token, with reuse detection. Both harnesses refresh (see [Harness facts](#harness-facts-design-inputs))                                                                       |
| P2  | Unauthenticated requests can take every consent slot                                                              | **Accepted (R).** Per-client and per-source caps, and a global cap that keeps headroom for others ([Admission](#admission-for-unauthenticated-routes))                                                                                        |
| P2  | The origin gate would break the existing `POST /oauth/token` exchange (`auth/http.rs:40`, `:119`)                 | **Accepted (R).** The rule applies per `grant_type`: the RFC 8693 exchange is unchanged                                                                                                                                                       |
| P2  | The stream collector ignores `action_failed`/`action_finished` (`production/git_vcs.rs:1613`, `:1618`)            | **Accepted (F0).** The collector normalizes both stream schemas, and tests cover each terminal event and a close before one ([C3](#c3-stream-invocation))                                                                                     |
| P2  | Git pathspec magic: `validate_pathspecs` checks components only (`git/repository.rs:11528-11549`)                 | **Accepted (G).** Literal pathspecs at the Git boundary for every caller, glob and magic syntax refused by the tool, and symlink containment checked where the operation runs ([C5](#c5-thread-targets-and-paths))                            |
| P2  | `idempotentHint` on `git_stage`, `git_unstage` and `interrupt_turn` (slice 1 sets it, `mcp/control.rs:567`)       | **Accepted.** The hint is removed from all three ([C2](#c2-annotations)). F0 fixes slice 1's `interrupt_turn`: it resolves the running turn and dispatches nothing when no turn runs                                                          |
| P2  | Branch delete is local first, then remote (`git/manager/operations.rs:1229-1261`): a remote failure is lost       | **Accepted (G).** The tool deletes in two steps and returns a typed partial outcome naming `git_delete_remote_branch`, a new remote-only operation                                                                                            |

**Advisor additions:**

- **Codex as an OAuth client** is now a design input. Its source (rust-v0.165.0) and the
  `rmcp` revision it pins were read. Slice R is shaped to what both harnesses do: see
  [Harness facts](#harness-facts-design-inputs).
- **Tunnel headers** were settled from source: the managed tunnel delivers the public
  hostname in `Host`, and whether the edge strips a client's `X-Forwarded-*` cannot be
  known from this repository. Slice R therefore does not depend on forwarded headers for
  the tunnel ([Origins](#origins-and-forwarded-headers)).

**Questions resolved by the user (2026-10-30):**

1. Destructive tools work at every operate level (kept).
2. `anthropic/requiresUserInteraction` stays off.
3. Terminals need all three gates, and a remote client reauthorizes to gain the terminal
   scope.
4. Remote consent is approved in BiBCode, bound to the exact client, redirect URI,
   resource and scopes.
5. DCR now; CIMD is a recorded follow-up.
6. Short-lived remote access tokens, with rotating refresh tokens (both harnesses refresh).
7. The extended scope of 2026-10-27 is designed in this round, with actor attribution
   early: slices X1 to X8 below.

The [Implementation partition](#implementation-partition) is rewritten as waves of at most
four writers.

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

| Slice    | What                                                                                                                                                                                      |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F0**   | Foundation: tool families, kind-aware registration, stream invocation, recorded outcomes that obey the live off switch, thread targets, capability sets, the slice-1 `interrupt_turn` fix |
| **A**    | Thread tools: `answer_approval`, `revert_thread_to_turn`, attachments on `start_thread`/`send_message`                                                                                    |
| **W**    | Worktree tools: list, create, removal plan, remove                                                                                                                                        |
| **G**    | Git write tools: stage, unstage, commit, undo commit, revert commit, push, force-push, fetch, pull, branch create/switch/delete, remote branch delete, discard                            |
| **P**    | Pull request tools: create, list, view, checks, update, merge                                                                                                                             |
| **T**    | Terminal tools under `terminal:operate`                                                                                                                                                   |
| **D**    | Device and browser preview tools for outside agents                                                                                                                                       |
| **X1**   | Actor attribution: who acted, on events, messages and threads; the agent activity log, indicator, **Stop** and **Take over**                                                              |
| **X2**   | Diagnostics tools: profiler, environment report, processes, traces (projected)                                                                                                            |
| **X3**   | `server_capabilities` and the `changes_since` feed                                                                                                                                        |
| **X4**   | Chat panels, `send_panel_message`, and the advisory `focus_ui` intent                                                                                                                     |
| **X5**   | Workspace file tools: list, read, search, write, create, rename, delete, download, upload                                                                                                 |
| **X6**   | Clone tools: clone, status, cancel                                                                                                                                                        |
| **X7**   | Source Control reads and the server-side commit draft                                                                                                                                     |
| **X8**   | Outbound webhooks and the Agent integrations MCP and Webhooks tabs                                                                                                                        |
| **R**    | Remote Streamable HTTP at `<environment>/mcp` with MCP OAuth                                                                                                                              |
| **Z**    | Cross-cutting docs, runbooks, and the `bibcode-mcp` skill and evals                                                                                                                       |
| —        | `bibcode thread` CLI: designed in slice 1 ("CLI front end"), implemented in parallel by another writer, and not redesigned here (see [CLI](#bibcode-thread-cli))                          |
| Deferred | The Tasks extension and resources, with reasons (see [Deferred](#deferred-tasks-and-resources))                                                                                           |

### Out of scope

- Settings, credentials, the updater, pairing, relay management, and CLI session import.
  No tool reaches `server.updateSettings`, `/api/auth/*` administration, `updater.*`,
  `cloud.*`, `connect.*` or `agentSessions.*`. The audience rule still keeps an
  `mcp-client` session off every RPC and HTTP route except `/mcp` (slice 1). The new
  OAuth routes take no MCP bearer.
- A server-side environment registry and a cross-environment proxy (extended-scope gap
  12). Each environment keeps its own `/mcp`, and an agent registers one server per
  environment. A registry would make one server the owner of other environments'
  credentials, which `remote.md` rules out for the relay too.
- `export_diagnostic_bundle`: see slice X2.

**How the extended scope of 2026-10-27 maps onto these slices.** The user included it in
this round (Question 7):

| Extended-scope item                                                                                      | Slice                                                                                        |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `scm_stage`, `scm_unstage`, `scm_commit`, `scm_run_operation`, `scm_discard`, `scm_undo_commit`          | G (hunk staging stays out, as G explains)                                                    |
| `scm_status`, `scm_diff`, `scm_log`, `scm_refs`, `scm_set_commit_message`, `scm_generate_commit_message` | slice 1's `git_status`, and X7                                                               |
| `create_worktree`, `list_worktrees`                                                                      | W                                                                                            |
| `open_terminal_panel`                                                                                    | T                                                                                            |
| `list_pending_requests`, `answer_pending_request`                                                        | slice 1's `list_pending_requests` and `answer_question`, and A's `answer_approval`           |
| Diagnostics (section A)                                                                                  | X2                                                                                           |
| `clone_repository`, `clone_status`, `cancel_clone`                                                       | X6                                                                                           |
| `create_chat_panel`, `list_chat_panels`, `send_panel_message`, `focus_ui`                                | X4                                                                                           |
| `files_*`                                                                                                | X5                                                                                           |
| Actor attribution, requester metadata, agent indicator, Stop, Take over                                  | X1                                                                                           |
| `server_capabilities`, `changes_since`                                                                   | X3                                                                                           |
| Per-environment capability sets                                                                          | F0 (contract, enforcement), T (switches)                                                     |
| Outbound webhooks, the Agent integrations tabs                                                           | X8                                                                                           |
| Typed errors                                                                                             | every slice, through the tag table in X3                                                     |
| "Approval in the UI" and "MCP never answers its own approval"                                            | superseded by the [user decision](#user-decision-2026-10-30): destructive tools run directly |

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

Facts this revision adds (verified at `ba143353d4`):

- **Off switch and revocation.** `McpControl::call` checks `enabled` once, at its start
  (`mcp/control.rs:428`); its shutdown token is separate (`:367`, `:376-378`).
  `AuthService::revoke_session` cancels every token registered for the session through
  `mark_connected_guard` (`auth/service.rs:1941-1975`, `:2054`; registry `:211`).
- **`interrupt_turn`.** `turnId` is optional, each call mints a fresh `commandId`
  (`mcp/control.rs:1530-1547`), and `describe` hardcodes `idempotentHint` for it (`:567`).
  The engine's interrupt holds the thread's queue and expires its pending requests whether
  or not a turn runs (`orchestration/engine.rs:5496-5525`).
- **Stacked actions** emit `action_started`, `action_finished` and `action_failed`
  (`production/git_vcs.rs:1522`, `:1613`, `:1618`), not the git manager's `finished` and
  `failed` (`packages/contracts/src/gitManager.ts:343-363`).
- **Pathspecs.** `validate_pathspecs` refuses absolute paths and non-`Normal` components
  only (`git/repository.rs:11528-11549`), so `:(glob)**` passes. Nothing in the Git layer
  sets `--literal-pathspecs`. `discard_paths` joins each path onto `cwd` for the trash
  without a containment check (`git/manager/operations.rs:2269-2283`).
- **Branch delete** deletes the local branch, then the remote one, and a remote failure
  returns an error that carries the local success (`git/manager/operations.rs:1229-1261`).
- **Forwarded headers.** From a loopback peer, the first `X-Forwarded-Host` replaces `Host`,
  and the header stays on the request (`http.rs:191-208`). An existing check treats a
  request as direct only when its `Host` is loopback and no `X-Forwarded-*` header is
  present (`production/connect_mcp.rs:1609-1612`).
- **Provider endpoint.** Providers are given `http://<bound address>/mcp`, loopback for a
  wildcard bind (`lifecycle.rs:918-931`). The relay dials the record's `dialHost`, which is
  loopback (`mcp/endpoint.rs:1-16`).
- **Managed tunnel.** The relay configures Cloudflare Tunnel ingress as
  `{ hostname, service }` per hostname and a final `http_status:404`, with no
  `originRequest` options (`infra/relay/src/environments/ManagedEndpointProvider.ts:741-753`).
  The connector runs on the host (`production/managed_endpoint.rs`), so its peer is
  loopback. The preview gateway recognizes tunnel traffic by a loopback socket plus a
  `Host` that names the managed hostname (`preview/gateway/relay.rs:85-91`), so the public
  hostname arrives in `Host`. Whether the edge removes a client's `X-Forwarded-Host` or
  `X-Forwarded-Proto` is not visible in this repository.
- **Tokens.** Session tokens are signed `SessionClaims` with their own `exp`
  (`auth/token.rs:73-85`). A one-hour session lifetime already exists for DPoP sessions
  (`auth/service.rs:41`).
- **Attribution.** `OrchestrationEventMetadata` has no actor
  (`packages/contracts/src/orchestration.ts:1480-1486`). `plan_command` starts every
  client event with empty metadata (`orchestration/engine.rs:3889`).
  `orchestration_events.actor_kind` exists (`persistence/migrations.rs:840`), but
  `infer_actor_kind` (`engine.rs:8122`) reads only a command-id prefix, so MCP and UI
  commands both read `client`, and `wire_event` never sends it
  (`production/orchestration_rpc.rs:2116-2130`). The dispatch handler has the principal in
  its context (`orchestration_rpc.rs:133-137`, `rpc/session.rs:398`), and MCP calls carry
  their `mcp-client` principal into it (`mcp/control.rs:793-798`). No message, thread or
  worktree records who created it.
- **Event sequence.** `orchestration_events.sequence` is a global autoincrement
  (`persistence/migrations.rs:830`). `orchestration.replayEvents {fromSequenceExclusive}`
  pages events (`production/orchestration_rpc.rs:176-215`, `:2250`). Nothing prunes the
  table. Worktree catalog, git manager and project entries signals carry only in-memory
  generations, or none (`worktree_catalog/service.rs:1029`, `git/broadcaster.rs:154`,
  `packages/contracts/src/project.ts:57-60`).
- **Panels and open requests.** `worktree.createPanel` takes a `commandId` and replays by
  claim (`production/worktree_catalog_rpc.rs:1399-1498`). Every client adopts a live
  panel as an inactive tab (`apps/web/src/centerPanelAdoption.ts:90-127`). Preview open
  requests are in-memory, expire after 60 s, allow 64 per thread, and the first
  `claimOpenRequest` wins (`preview/mod.rs:24-27`, `:483-536`;
  `apps/web/src/components/preview/OpenRequestRouter.tsx:25`).
- **Workspace files.** Reads cap at 1 MiB and refuse binary content
  (`workspace/service.rs:19`, `:262-285`). `writeFileIfUnchanged` takes a version or
  `missing` precondition under a per-path lock (`:344-375`); no write size cap exists.
  `deleteEntry` hard-deletes (`:486-512`). Reads and deletes check symlink containment,
  writes check the deepest existing ancestor (`workspace/paths.rs:33-100`). Transfer URLs
  last 5 minutes and are their own authority (`transfer/mod.rs:15`,
  `production/transfer_routes.rs:1-6`); `?overwrite=1` is a query flag, not part of the
  token (`production/http_routes.rs:705`).
- **Clone.** `vcs.clone` is unary, with no server progress; one live clone per destination,
  16 at once, and `detach: true` keeps it running after the caller leaves
  (`production/clone_operations.rs:1-41`, `:286`). No setting limits where clones go
  (`production/host_paths.rs:24`). The web registers the project with a separate
  `project.create` (`apps/web/src/components/add-project/useAddProjectWorkflow.ts:715-750`).
- **Commit draft.** It lives only in browser storage, keyed by environment and `cwd`
  (`apps/web/src/sourceControlPanelStore.ts:41`, `:90-94`;
  `apps/web/src/sourceControlDraft.ts:12-15`). `vcs.generateCommitMessage` is
  deterministic ("Update <paths>", `production/git_vcs.rs:3316`).
- **Diagnostics.** The profiler's stdio tools are private, pure functions over a disk
  `Reader` (`diagnostics/profiler/mcp.rs:89-254`, `reader.rs:119`).
  `server.getProcessDiagnostics` returns raw command lines without redaction
  (`production/server_terminal.rs:589`, `:1843`). `server.getConfig` includes
  `mcpLaunch.argv`, paths and the full settings (`production/control.rs:467-489`,
  `:2077-2091`). `server.log` rotates at 4 MiB with 3 backups (`logging.rs:21-22`), and
  `redact_sensitive_text` blanks a line's tail after a credential marker
  (`diagnostics/trace.rs:474`).
- **Webhooks.** None exist. `reqwest` and `hmac` are dependencies (`apps/server/Cargo.toml:37`,
  `:55`). `SecretStore` keeps 0600 plaintext files (`auth/secret_store.rs:18`, `:549`).
- **Agent integrations.** The section renders the environment picker, the MCP server
  switch, **Agents may**, and the launch commands
  (`apps/web/src/components/settings/AgentIntegrationsSection.tsx:66-277`). It lists no
  authorized clients.

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
- **`idempotentHint`** is set only when a repeat with the same arguments has no further
  effect **without** a `clientRequestId`, whatever changed in between. Hints are per tool,
  not per call, so a tool qualifies only if every argument combination does:
  - reads;
  - `git_fetch`;
  - `terminal_resize`.

  Not idempotent, after the review:
  - `git_stage` and `git_unstage` act on the file's state at call time
    (`production/git_vcs.rs:628-640`). If a person edits or stages the file between two
    calls, a repeat changes the index again.
  - `interrupt_turn` with no `turnId` would stop whatever runs next. Slice 1 marks it
    idempotent (`mcp/control.rs:567`); F0 removes the hint.

  Destructive tools never carry it, so a harness never repeats them on its own. Claude
  Code repeats an `idempotentHint` or `readOnlyHint` call once, on a new connection, when
  the old one closed with the call pending (its MCP docs, "safe to call twice").

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
  - **Two stream schemas.** The collector takes a `StreamSchema` per method, so success
    and failure are explicit, never inferred from "the last chunk":
    - `gitManager.runOperation`: `output` lines; `finished` is success; `failed` is a typed
      tool error carrying its `code` and `blocked` reason (`gitManager.ts:343-363`).
    - `git.runStackedAction`: `action_finished` is success; `action_failed` is a typed
      tool error carrying its `phase` and message (`git_vcs.rs:1613`, `:1618`). The other
      `action_*` progress kinds count as output.
    - Any other kind is ignored and counted. A stream that **ends before a terminal
      event**, or whose receiver closes first, returns `McpStreamEndedError`. Under a
      recorded outcome (C4) that is `unknown`, never success.
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
2. **New row.** The call runs as a task owned by `McpControl` (an **owned mutation**), so
   a cancelled MCP call stops waiting but not the work. It writes `state = 'done'` with the
   bounded tool result, or `state = 'failed'` with the typed error. An in-process claim map
   holds the key while the task runs. The owned mutation obeys the live controls (below).
3. **Row is `done`, `failed` or `unknown`.** The call returns the stored outcome unchanged;
   `unknown` returns `McpOutcomeUnknownError` with its reason.
4. **Row is `running` and the claim is held** (a concurrent retry). The call awaits the
   claim within its own deadline, then reads the outcome.
5. **Row is `running` with no claim** (the server restarted or crashed mid-call). The
   call returns `McpOutcomeUnknownError`: "BiBCode cannot tell whether this ran. Check
   `git_status` (or `view_pull_request`), then retry with a new clientRequestId." It
   never re-runs.

Without a `clientRequestId`, a call runs inline and cancellation propagates, as today.
Stored outcomes are tool results, capped at 80,000 characters. They are pruned at 24 hours
with their rows, like slice 1's.

**Live controls for owned mutations (review P1).** Without these, a keyed force-push could
finish after the person turned MCP off, because `call` checks `enabled` only at its start
(`mcp/control.rs:428`). Each owned mutation:

- **Runs under one cancellation token**, the child of three sources:
  - `McpControl::shutdown`;
  - a settings watch that fires when `enabled` turns off or the effective ceiling drops to
    `read-only` (`McpControl` already holds the `watch::Receiver`, `mcp/control.rs:308`, `:549`);
  - the session's revocation: the task registers through
    `AuthService::mark_connected_guard(session_id, token)` (`auth/service.rs:2054`), so
    `revoke_session` cancels it (`:1951`). The guard also makes the client show as
    connected in Authorized clients while it works.
- **Passes that token to the RPC handler** as its cancellation, so Git and the hosting
  client stop as they do on a UI disconnect.
- **Holds its admission until it settles.** The registry admission permit, and one of
  `McpControl`'s new owned-mutation slots (2 per session, 8 per environment), are released
  when the outcome is written, not when the MCP call returns. Cancel-and-retry therefore
  cannot pile up detached work. A call over the limit gets `McpBusyError`.
- **Records `unknown` when interrupted.** If the token fires before the handler returns a
  terminal result, the row becomes `state = 'unknown'` with the reason (`mcp-disabled`,
  `read-only`, `revoked` or `shutdown`). A push or PR create cut off mid-flight may or may
  not have reached the remote, so success is never claimed. If the handler returns its
  terminal result first, that result is recorded.

Handler-owned operations are not owned mutations and are not aborted: an engine command
already accepted, and a worktree removal running in the catalog's own
`operation_runtime` (slice W). Aborting a removal part-way leaves orphan cleanup, which is
worse than finishing it; it is local and bounded. The off switch refuses their next call.

### C5. Thread targets and paths

Every workspace tool takes `threadId`. The server resolves `cwd` (the thread's worktree
path, else the project root) and `projectId`. `git_status`'s resolver (`control.rs:1609-1630`)
moves to a shared `mcp/target.rs`.

Tools that name files (`git_stage`, `git_unstage`, `git_discard`, and the `files_*` tools
of X5) take workspace-relative paths. This extends slice 1's "ids, never paths" rule,
because the operations are file-scoped. The rules are checked in two places.

**In the tool (`mcp/target.rs`), before any RPC:**

- each path is at most `PROJECT_ENTRY_PATH_MAX_LENGTH`;
- a path that is absolute, contains `..` or NUL, or resolves outside `cwd` is refused;
- a path that starts with `:`, or contains `*`, `?`, `[` or `\`, is refused with
  `McpInvalidArgumentError` ("paths are literal file paths; globs and pathspec magic are
  not accepted"). A real file whose name contains these characters cannot be named over
  MCP; that is the price of a check an agent can predict;
- at most 200 paths per call.

**At the operation boundary (slice G), for every caller, the UI included:**

- Git commands that take file pathspecs from a caller (`stageFiles`, `unstageFiles`,
  `discardFiles`, `gitManager.discard` and its tracked-path listing) run with
  `--literal-pathspecs`. `:(glob)**` is then a file name that matches nothing, not the
  whole tree. The UI sends only real paths, so its behavior does not change; a test
  pins that a directory path still stages its contents.
- `discard_paths` canonicalizes each target's parent and refuses one outside the
  canonical `cwd`, before it trashes or restores anything. A symlinked directory inside
  the worktree that points elsewhere can no longer route a discard outside it. (The
  workspace file service already does this for reads and deletes, `workspace/paths.rs:63-100`.)

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

  The user kept this at every operate level (Question 1).

- **"Supervised" changes meaning.** With `answer_approval`, a Supervised thread stops for
  an approval, but whoever drives it may answer, and that can be the agent. A Supervised
  ceiling bounds how a thread runs, not who approves it. This changes the slice-1 UI copy
  and the docs.
- **Injected instructions can now cause loss.** Thread transcripts, terminal output, pull
  request bodies and check logs are untrusted. They can carry instructions such as "now
  run `git_force_push`", or an approval request crafted by a tool, and an agent that
  follows them can destroy work. Results are already marked untrusted (slice 1), but that
  is advice to the agent, not a control.
- **Until slice X1 lands, nothing in the UI says who acted.** A removal or force-push made
  over MCP looks the same as one a person made. The trail is then the Authorized clients
  row, `server.log` (C7), and the profiler's `worktree.removal` events. X1 is therefore
  in the second wave, right after the tool families.

**Mitigations that remain:**

- **Per-environment off switch.** `enableMcpServer` off ends every outside agent at once,
  live (slice 1), including owned mutations in flight (C4).
- **Read only.** `mcpServerAccess: read-only` hides and refuses every mutating tool, live,
  and interrupts owned mutations (C4).
- **Revocation.** Revoking the agent's row in Authorized clients ends it on its next call
  and interrupts its owned mutations (C4). **Stop** and **Take over** (X1) put both a
  click away.
- **Capability sets** (C8) switch off a whole family per environment, live.
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
- **Activity.** Once X1 lands, every mutating call also writes one activity row that the
  UI shows (X1). It holds no content either.

### C8. Capability sets

The extended scope asks to enable families per environment, for example full control
locally and read-only diagnostics on a production remote.

**Alternatives:**

- One boolean per family, added as each slice lands (`mcpAllowTerminals`, then more).
  Each slice would then add its own setting, check and switch.
- **Chosen:** one setting, `mcpCapabilities`, defined once in F0:

  | Set             | Tools                                   | Default |
  | --------------- | --------------------------------------- | ------- |
  | `workspace`     | slice 1's thread tools, A, W, D, X4, X6 | on      |
  | `sourceControl` | slice 1's `git_status`, G, P, X7        | on      |
  | `files`         | X5                                      | on      |
  | `diagnostics`   | X2                                      | on      |
  | `terminals`     | T                                       | **off** |

  `server_capabilities` and `changes_since` (X3) belong to no set and are always listed.
  The defaults keep slice 1's behavior, and the user's "included fully" decision, for
  everything but terminals.

**Enforcement.** `ToolSpec` gains `capability`. `tools()` hides a tool whose set is off,
and `call` refuses it with `McpCapabilityDisabledError` ("Turn on <set> for MCP agents in
Settings → Agent integrations"). Both read the live settings, as the ceiling does, so a
change applies without a restart. A harness that cached its list keeps showing the tools;
their calls fail typed.

## Slice F0: Foundation

Status: Approved 2026-10-30 (user pre-approval; reviewed by Codex and advisor).

**Owns:** C1 to C5 and C8, migration 59, the live controls for owned mutations, and the
slice-1 `interrupt_turn` fix.

F0 starts from the batch branch after the `bibcode thread` CLI (branch
`claude/v0131-139-cli`) lands there. That branch edits `mcp/control.rs` (`tool_text`,
`list_projects_and_threads`, `read_thread`) and `mcp/relay.rs`, which F0 moves; the CLI's
changes then move with the code instead of conflicting with it.

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
- **Capability sets contract (C8).**
  - `ServerSettings`/`ServerSettingsPatch` gain `mcpCapabilities` (the five booleans
    above; the patch takes any subset), with fixtures (`packages/contracts/src/settings.ts`).
  - It is validated and published on `mcp_server_signal()`, and `McpServerSettings` gains
    `capabilities` (`production/control.rs`, `mcp/control.rs:106-135`).
- **Issuer.** `issue_mcp_pairing_link` takes an optional extra-scope list, which only
  `terminal:operate` may use.
  - The relay asks for it when `mcpCapabilities.terminals` is on **and** the ceiling is
    `full-access` at mint time.
  - The relay mints on its first request (slice-1 implementation note).
- **Live controls (C4).** `mcp/outcome.rs` runs owned mutations under the combined token,
  holds their slots to settlement, and writes `unknown` on interruption.
- **`interrupt_turn` fix (review P2, slice-1 code in PR #213).**
  - Without `turnId`, the tool reads the thread's running turn (its `latest_turn_id` while
    the latest turn is `running`) and puts that id in the command.
  - When the named or resolved turn is not running, it dispatches nothing and returns
    `{ interruptRequested: false, turnRunning: false }`. A repeat therefore never holds the
    queue or expires the requests of a turn that started later
    (`orchestration/engine.rs:5496-5525`).
  - The hardcoded `idempotentHint` (`mcp/control.rs:567`) is removed, because hints are per
    tool. The race between the check and the dispatch remains; the UI's stop button has
    the same one.
- **Profiler.** `diagnostics/profiler/latency.rs` gets the kind-aware lookup.
- **Tests.** `production/mcp_tools_tests.rs` becomes a directory module
  (`mcp_tools_tests/mod.rs` plus `threads.rs`), so each slice adds its own test file.

**Failure and cancellation:**

- `invoke_local_stream` drops its receiver on cancel, budget and shutdown.
- Owned mutations are tracked in `McpControl` and stop at `McpControl::shutdown`, the off
  switch, read-only and revocation (C4). A row left `running` by a crash answers
  `McpOutcomeUnknownError` on its next retry, which is never a false success.

**Tests (written to fail first):**

- **Wait slots.** Five concurrent `git_push` calls and a `device_open` do not take a wait
  slot, and a fifth `wait_for_thread` is still refused with `McpBusyError`.
- **Kind-aware names.** A client tool named `device_list` coexists with the provider's,
  and each kind's `tools/list` shows only its own.
- **Hints.** `describe` emits `destructiveHint: true` for a spec marked destructive.
  Today it hardcodes `false`.
- **Stream invocation**, through fake stream handlers of both schemas:
  - `failed` and `action_failed` each become a typed error, with `code` or `phase`;
  - `finished` and `action_finished` each become success;
  - a stream that closes before a terminal event returns `McpStreamEndedError`;
  - cancel mid-stream drops the receiver;
  - an `output` flood is capped at the collector's bound;
  - a stream method without the scope is refused before the handler runs.
- **Recorded outcomes:**
  - two sequential calls with one key run the handler once and return the same result;
  - concurrent calls run it once;
  - a `running` row with no claim returns `McpOutcomeUnknownError` and does not run;
  - another digest returns `idempotency_conflict`;
  - a slice-1 `commands` row still replays by receipt;
  - a keyed retry after each of success, typed failure and stream-ended returns the
    stored outcome without running the handler.
- **Live controls**, with a fake handler that blocks until cancelled:
  - turning `enableMcpServer` off mid-call cancels the handler and records `unknown`
    (`mcp-disabled`); a retry returns `McpOutcomeUnknownError`;
  - dropping the ceiling to read-only, and revoking the session, do the same;
  - a handler that finishes before the switch records its result;
  - the MCP call cancelled by its client leaves the handler running, and a third
    owned mutation for the session gets `McpBusyError` until one settles.
- **`interrupt_turn`.** With no running turn it dispatches nothing; a second call after
  the turn ended does not hold the queue of a turn queued behind it; `tools/list` no
  longer marks it idempotent.
- **Capability sets.** With `files` off, the X5 tools are hidden and refused with
  `McpCapabilityDisabledError`, live; the defaults list every slice-1 tool.
- **Paths.** Path validation refuses absolute paths, `..`, NUL, a symlink that escapes
  `cwd`, `:(glob)**`, `*.rs`, and 201 paths.
- **Unchanged behavior.** The slice-1 integration suite passes unchanged after the move,
  and the provider `preview_*`/`device_*` suite in `connect_mcp/tests.rs` passes
  unchanged.

## Slice A: Thread tools (approvals, checkpoint revert, attachments)

Status: Approved 2026-10-30 (user pre-approval; reviewed by Codex and advisor).

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

Status: Approved 2026-10-30 (user pre-approval; reviewed by Codex and advisor).

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

Status: Approved 2026-10-30 (user pre-approval; reviewed by Codex and advisor).

Every tool here takes `threadId` (C5), and the server adds `cwd` and `projectId`. Retries
use recorded outcomes (C4). Push, fetch and pull are marked `long_running: true`, because they
wait on a network.

| Tool                       | Arguments                                                                                               | Maps to                                                                                                            | Hints                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| `git_stage`                | `paths[]`                                                                                               | `vcs.stageFiles`                                                                                                   | —                               |
| `git_unstage`              | `paths[]`                                                                                               | `vcs.unstageFiles`                                                                                                 | —                               |
| `git_commit`               | `summary`, `description?`, `clientRequestId?`                                                           | `gitManager.commit` with `amend: false`, `noVerify: false`, `signoff: false`, `allowEmpty: false`, `coAuthors: []` | not idempotent                  |
| `git_undo_commit`          | `clientRequestId?`                                                                                      | `gitManager.undoCommit`                                                                                            | **destructive**                 |
| `git_revert_commit`        | `sha`, `clientRequestId?`                                                                               | `runOperation revert`                                                                                              | not destructive (adds a commit) |
| `git_push`                 | `remote?` (upstream or `origin`), `branch?` (current), `remoteBranch?`, `pushTags?`, `clientRequestId?` | `runOperation push`, or `publish-branch` when there is no upstream                                                 | open world                      |
| `git_force_push`           | the same as `git_push`                                                                                  | `runOperation force-push` (`--force-with-lease`)                                                                   | **destructive**, open world     |
| `git_fetch`                | `remote?`                                                                                               | `runOperation fetch`                                                                                               | idempotent, open world          |
| `git_pull`                 | `remote?`, `clientRequestId?`                                                                           | `runOperation pull`                                                                                                | open world                      |
| `git_create_branch`        | `name`, `startPoint?`, `checkout` (true)                                                                | `runOperation branch-create`                                                                                       | —                               |
| `git_switch_branch`        | `name`, `carryChanges?` (`stash` or `bring`)                                                            | `runOperation branch-checkout`                                                                                     | —                               |
| `git_delete_branch`        | `name`, `force` (false), `deleteRemote` (false), `clientRequestId?`                                     | `runOperation branch-delete` (local only), then `remote-branch-delete` (below)                                     | **destructive**                 |
| `git_delete_remote_branch` | `remote`, `branch`, `clientRequestId?`                                                                  | new `runOperation remote-branch-delete`                                                                            | **destructive**, open world     |
| `git_discard`              | `paths[]`, `permanent` (false), `clientRequestId?`                                                      | `gitManager.discard` (`permitPermanent = permanent`)                                                               | **destructive**                 |

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
- Cancelling a call with a key stops the wait, not the push (C4). Turning MCP off,
  read-only, or a revocation does stop it, and records `unknown` (C4).
- Cancelling a call without a key cancels the stream as a UI disconnect does.

**Branch delete in two steps (review P2).** The handler's combined delete removes the
local branch and then pushes the remote deletion, and a remote failure comes back as an
error although the local branch is gone (`git/manager/operations.rs:1229-1261`). Recording
that as `failed` would replay a failure for a half-done change, and a new call would no
longer find the upstream. So:

- G adds `remote-branch-delete { cwd, remote, branch }` to `GitManagerOperationRequest`
  (`packages/contracts/src/gitManager.ts`), run by the existing
  `git_manager_delete_remote_branch` (`operations.rs:1255`). The Source Control panel may
  use it later; it does not change today.
- `git_delete_branch` resolves the upstream first. With `deleteRemote: true` and no
  upstream it refuses before deleting anything (the handler's own `no-upstream` rule).
- It then runs the local delete, then the remote delete, as two operations. The outcome
  it records is one of:
  - `{ local: "deleted", remote: "deleted" | "not-requested" }`;
  - a typed `McpPartialOutcomeError` with `local: "deleted"`, `remote: "failed"`, the
    remote, the remote branch, the reason, and the recovery call
    `git_delete_remote_branch { remote, branch }`. A keyed retry replays this partial,
    which is the truth.
- `git_delete_remote_branch` also serves an agent that wants only the remote gone.

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
- with a remote that refuses the deletion, `git_delete_branch` returns the partial
  outcome, the local branch is gone, a keyed retry replays the partial, and
  `git_delete_remote_branch` then removes the remote branch;
- a path that escapes the workspace is refused;
- `git_stage` with `:(glob)**` is refused by the tool; `vcs.stageFiles` called directly
  with it stages nothing (literal pathspecs), and with a directory path still stages the
  directory's files;
- `git_discard` through a symlinked directory that points outside the worktree is
  refused, and the target outside is untouched;
- a blocked operation returns its typed reason;
- a cancelled push with a key still records `done`, and the retry returns it;
- a keyed push to a bare remote behind a slow hook, with MCP turned off mid-push, records
  `unknown`, and the retry returns `McpOutcomeUnknownError`;
- a captured tracing subscriber never sees a commit message, path or branch name.

## Slice P: Pull request tools

Status: Approved 2026-10-30 (user pre-approval; reviewed by Codex and advisor).

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
- a create that ends with `action_failed` returns a typed error and records `failed`, and
  a keyed retry returns that failure without calling the host;
- a create whose stream closes before `action_finished` records `unknown`;
- merge with a stale `headSha` is refused;
- merge never sends `bypass`;
- view caps a long body and reports its length;
- an unavailable host (`PullRequestsContext.status: "unavailable"`) comes back as a
  typed error, not an empty list.

## Slice T: Terminals

Status: Approved 2026-10-30 (user pre-approval; reviewed by Codex and advisor).

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
  1. **The setting** `mcpCapabilities.terminals` (default **off**) is on.
  2. **The credential holds `terminal:operate`.** The stdio relay asks for it when the
     setting is on and the ceiling is `full-access` at mint time (F0). The OAuth approval
     card offers it under the same two conditions, and only when the client asked for the
     scope (slice R).
  3. **The effective ceiling is `full-access`.** Full access is the only level at which a
     thread runs commands without approval, so an agent's terminal, which runs any
     command, needs the same.

Turning the setting off, or lowering the ceiling, hides and refuses the tools at once.
Turning it on reaches a stdio agent only after its MCP server restarts and mints again, as
the ceiling does. A remote OAuth client must reauthorize and ask for `terminal:operate`,
because a refresh cannot widen a grant (slice R).

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

Slice T owns the MCP tab's controls for C8. Under **Agents may**, a **What agents can use**
group has one switch per capability set:

- **Threads and worktrees**, **Source Control and pull requests**, **Files**,
  **Diagnostics**: on by default.
- **Terminals**: "Let MCP agents open terminals and run any command in this
  environment." Off by default.
  - It is disabled with "Set Agents may to Full access first." while the ceiling is
    lower.
  - Agents pick it up only after their MCP server restarts, or after a remote agent
    reauthorizes; the description says so.
- The whole group is disabled with "Turn on MCP server first." while the server is off.
- Switching asks nothing, because every switch is reversible and applies live.

T also owns the MCP tab's copy changes (UI review below).

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
  output;
- web: each capability switch writes its own key of `mcpCapabilities`, and the
  Terminals switch is disabled with its reason below Full access.

## Slice D: Device and browser previews for outside agents

Status: Approved 2026-10-30 (user pre-approval; reviewed by Codex and advisor).

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

## Extended scope (slices X1 to X8)

The user included the extended scope of 2026-10-27 in this round. Each slice below uses
the same registry, per-call checks, untrusted-output marking, caps and cursors as the tool
slices above, and the facts it rests on are in [Current behavior](#current-behavior-verified-at-ba143353d4).
Every tool takes ids, plus workspace-relative paths only where C5 allows them.

## Slice X1: Actor attribution and agent activity

Status: Approved 2026-10-30 (user pre-approval; reviewed by Codex and advisor).

Agent actions now look like a person's (C6), so this slice comes in the second wave.

**Current behavior.** Events carry no actor, `actor_kind` is inferred from a command-id
prefix and never sent, and no message, thread or worktree records its creator (see
"Attribution" above). Git and file RPCs emit no orchestration events at all.

**Alternatives:**

- Prefix MCP command ids with `mcp:<sid>:`, so `infer_actor_kind` (`engine.rs:8122`)
  marks them. Cheap, but a command id is chosen by the client, so any UI client could
  claim to be an agent, and it carries no label.
- Add `actor` to every command schema. Every client could then claim any actor.
- **Chosen: the server stamps the actor from the authenticated principal.** No client
  input decides it.

**Design:**

- **Actor.** `{ kind: "mcp-client", clientId, label }`. `clientId` is the session id and
  `label` the Authorized clients label at dispatch time. It is set only for an
  `mcp-client` principal (`auth/service.rs:57`); a person's commands carry none, so the
  default renders as today.
- **Stamping.** The `orchestration.dispatchCommand` handler takes the actor from its
  context (`orchestration_rpc.rs:133-137`) and passes it to the engine's dispatch. MCP
  calls already arrive with their principal (`mcp/control.rs:793-798`).
  `worktree.createManaged` and `worktree.createPanel`, which dispatch `thread.create`
  themselves (`worktree_catalog_rpc.rs:1485-1498`), pass their context's actor too.
- **Events.** `plan_command` writes `metadata.actor` on every event it plans for that
  command (`engine.rs:3889`), and `infer_actor_kind` returns `mcp-client` when it is set.
  The metadata column is JSON, so events need no migration. `wire_event` sends it, and
  `OrchestrationEventMetadata` gains an optional `actor`
  (`packages/contracts/src/orchestration.ts:1480-1486`).
- **Projections.** `projection_thread_messages.actor_json` (a user-role message an agent
  sent) and `projection_threads.requester_json` (`{ actor, purpose }` for a thread an agent
  created, worktree host threads and panels included). `projection_thread_messages` also
  gains `source_thread_id`, which X4 uses for provenance; this keeps X4 free of a
  migration.
- **Purpose.** `start_thread`, `create_worktree` and `create_chat_panel` (X4) take an
  optional `purpose` (at most 200 characters, untrusted text). It travels in a new
  optional `purpose` field of `thread.create` and is shown, never logged.
- **Activity log.** `mcp_activity` holds one row per **mutating** tool call: time,
  session, label, tool, `threadId`, outcome tag, and a structured target with no content
  (commit SHA, PR number, worktree key, file count, clone or transfer id). `McpControl`
  writes it when the call settles. Rows are pruned after 7 days or past 5,000. A write
  failure is logged with `tracing::warn!` and does not fail the call, so a push that
  happened is not reported as failed.
- **Stream.** `subscribeMcpActivity` (read stream, `access:read`) sends the last 200 rows
  and then each new one, plus `active`: each client with a call in the last 2 minutes or
  an owned mutation running.
- **Stop.** Revokes the client (the existing revoke route), which ends its calls and owned
  mutations (C4), and interrupts each running turn whose latest user message carries that
  client's actor.
- **Take over.** Sets that client's `mcp_access` to `read-only` through a new
  `POST /api/auth/clients/mcp-access { sessionId, access }` (`access:write`). The agent
  can still read; every mutating call is refused, and the route cancels the session's live
  tokens so owned mutations stop (C4). **Hand back** restores the previous level. Nothing
  else needs a lock: a person can always type in any thread.

**UI** (UI.md: show who acted, keep the controls one click away):

- An **Agent · <label>** chip on agent-sent messages (`MessagesTimeline.tsx`
  `UserTimelineRow`, `:1283`) and on threads and panels an agent created, with the purpose
  in its tooltip.
- Source Control commit rows show the chip when their SHA is in a recent activity row;
  commits have no event of their own.
- While any agent is active, the app header shows **Agent active · <label>** with
  **Stop** and **Take over** (or **Hand back**).
- The MCP tab gains **Agents**: each authorized MCP client with its label, last call,
  scopes and access, and **Revoke** and **Take over**; below it, the activity list.
  Stop and Revoke ask for no confirmation: both are reversible by reconnecting, and they
  only stop an agent.

**Trust boundaries.** The actor comes only from the authenticated session. Labels and
purposes are untrusted text, rendered as text. Activity rows hold ids and counts, never
paths, messages or output.

**Profiler.** One new stream, registered through the `rpc/session.rs` wrappers; one new
HTTP route, which logs failures with `tracing::warn!`. No new process, and nothing new in
fingerprints.

**Tests (fail first):**

- a `start_thread` over MCP produces events whose `metadata.actor` names the client, and
  the UI's own dispatch produces none;
- a client cannot set `actor` by sending it in a command;
- `create_worktree` and `create_chat_panel` stamp the host thread and the panel;
- `read_thread` and the shell snapshot carry the message actor and the thread requester;
- one activity row per mutating call and none per read; a replayed retry adds none;
- **Stop** revokes, interrupts the agent's running turn, and cancels an owned mutation;
- **Take over** makes the next mutating call refused and stops an owned mutation, and
  **Hand back** restores it;
- web: the chip renders for an actor and not without one; the indicator appears with an
  active client and its buttons call the two routes.

## Slice X2: Diagnostics tools

Status: Approved 2026-10-30 with the Revision 4 requirements (user pre-approval; reviewed by Codex and the advisor).

**Current behavior.** The profiler's tools exist only on the stdio `bibcode profiler mcp`
server, as private pure functions over a disk `Reader`. The diagnostics RPCs are unary
reads, except `server.refreshProviders` (operate). `getProcessDiagnostics` returns raw
command lines, and `getConfig` carries paths and the launch argv (see "Diagnostics"
above).

**Alternatives:**

- Proxy the agent to `bibcode profiler mcp`. That needs a second MCP server per
  environment, and it is unreachable over remote HTTP.
- **Chosen:** mount the profiler handlers and new diagnostic tools on `/mcp`, in the
  `diagnostics` capability set, scope `orchestration:read` (as `server.getProfilerStatus`
  is, `auth/scope.rs:68`).

| Tool                   | Arguments                       | Maps to                                                                                    | Hints                 |
| ---------------------- | ------------------------------- | ------------------------------------------------------------------------------------------ | --------------------- |
| `profiler_status`      | —                               | the stdio handler, in-process over the server's own profiler `Reader`, in `spawn_blocking` | read-only, idempotent |
| `profiler_findings`    | `since?`, `kind?`, `limit?`     | the same                                                                                   | read-only, idempotent |
| `profiler_events`      | `since?`, `kind?`, `limit?`     | the same                                                                                   | read-only, idempotent |
| `profiler_crash`       | `id`                            | the same, with local symbols only                                                          | read-only, idempotent |
| `diagnose_environment` | —                               | `server.getConfig` (projected), `server.discoverSourceControl`, `server.getProfilerStatus` | read-only, idempotent |
| `refresh_providers`    | —                               | `server.refreshProviders` (operate)                                                        | idempotent            |
| `process_diagnostics`  | `historyWindowMs?`, `bucketMs?` | `server.getProcessDiagnostics`, `server.getProcessResourceHistory` (projected)             | read-only, idempotent |
| `trace_diagnostics`    | `limit?`                        | `server.getTraceDiagnostics` (projected)                                                   | read-only, idempotent |

Decisions:

- **`profiler_symbolicate` stays on stdio.** Its `symbolsDir` is an arbitrary host path,
  and `download` fetches symbols for minutes from GitHub (`diagnostics/profiler/mcp.rs:254`).
- **Every tool returns an allowlisted projection (review, Revision 3).** A secret-pattern
  redactor cannot keep content out: `redact_sensitive_text` blanks only the tail after a
  credential marker (`diagnostics/trace.rs:527`), and the server logs provider output
  lines verbatim (`production/provider_runtime.rs:19265`). So the tools build their output
  from named fields and drop everything else:
  - **`diagnose_environment`** returns the environment descriptor's version and
    capability flags, each provider's install, auth and version state, and the count and
    kind of each config issue, never its message. It never returns paths, settings,
    `mcpLaunch` or the auth descriptor.
  - **`process_diagnostics`** returns, per process, `pid`, `ppid`, `depth`, `status`,
    `elapsed`, the CPU and memory samples, and BiBCode's attribution `scope`, `kind` and
    `confidence`, plus the totals and buckets. It never returns `command` or the
    attribution `label`, a registrant's free text (wire shapes:
    `production/server_terminal.rs:1789`, `:1865`).
  - **`trace_diagnostics`** returns span names, counts, durations, failure and
    interruption counts, and the log level counts. It never returns a failure's `cause`,
    a log entry's `message`, or a file path (`diagnostics/trace.rs:310-395`); a `cause`
    holds up to 8,192 characters of arbitrary error text (`:465-471`).
  - **The profiler tools** return the profiler's own records, as the stdio server does.
    Those are content-free by the profiler's rules (AGENTS.md: never record prompt,
    message or terminal content), with paths through `diagnostics/profiler/redact.rs`.
- **No server log tool.** `server.log` is a plain-text `fmt` layer (`logging.rs:1561`),
  so its lines have no fields to allowlist, and filtering text would only redact. An
  agent diagnoses through findings, events, crashes, processes and traces; a person still
  reads the logs and downloads the bundle in the UI. A structured warning feed from a
  `tracing` layer is a possible follow-up, not part of X2.
- **`export_diagnostic_bundle` is not offered.** It is an in-memory 20 MiB archive built
  for a person (`diagnostic_bundle.rs`), the zip route refuses an `mcp-client` bearer
  (audience rule), it holds the raw logs, and crash dumps are binary.

**Trust boundaries.** All output is untrusted. Content is kept out by projection, not by
redaction: no prompt, message, tool output, command line or log text reaches an agent.

**Profiler.** `mcp.refresh_providers` is long-running through its method
(`latency.rs:156`); the others do bounded disk or memory reads.

**Tests (fail first):** each profiler tool over `/mcp` matches the stdio result on a
fixture store; a process whose command line holds a marker string, and a trace failure
whose `cause` holds it, never return the marker; `diagnose_environment` contains no path;
with `diagnostics` off the tools are hidden.

## Slice X3: `server_capabilities` and `changes_since`

Status: Approved 2026-10-30 (user pre-approval; reviewed by Codex and advisor).

**`server_capabilities`** (no capability set; read-only, idempotent) returns:

- the server version and MCP protocol versions (from the environment descriptor,
  `production/control.rs:2636-2693`);
- a `toolsVersion`, the hash of this principal's visible tool list, so an agent knows when
  to list again;
- the effective ceiling, the capability sets, and the scopes held;
- the **typed error table**: every tag a tool returns, with what it means and what fixes
  it. This answers "clear errors": disabled server, capability off, scope missing,
  busy, outcome unknown, idempotency conflict, partial outcome, credential refused (HTTP
  401). The relay must turn a refused credential or an unreachable server into a typed
  tool result; verify slice 1's relay does, and fix it here if not.

**`changes_since { cursor?, threadId?, limit (100, at most 500) }`** (no capability set;
read-only, idempotent).

**Alternatives:**

- A new change table written by every subsystem. That duplicates the event log.
- `orchestration.replayEvents` as is. It returns whole event payloads, content included
  (`orchestration_rpc.rs:2116-2130`).
- **Chosen:** a filtered, content-free read of two durable sequences:
  - `orchestration_events.sequence` (`persistence/migrations.rs:830`), mapped to
    transitions: thread created or archived, panel created, turn started, completed,
    interrupted or failed, approval and input requested or resolved, session status;
  - `mcp_activity` ids (X1), for git operations, pull requests, clones and transfers an
    agent ran.

**Rules:**

- An entry is `{ cursor, at, kind, threadId?, status?, requestId?, actor? }`, with no
  text.
- The cursor is opaque (`v1.<sequence>.<activityId>`) and strictly increasing. Both
  sequences are durable, so nothing is missed across a reconnect or a restart.
- With no cursor, the call returns the current head and no entries, so an agent starts
  from now.
- One call scans at most 5,000 events and returns the last scanned position, even when
  few matched.
- Events are never pruned. Activity rows are (X1), so a cursor older than the oldest row
  reports `activityDropped: true`.
- **Not in the feed:** Git operations a person ran in the UI, and worktree catalog or file
  changes, because no durable record of them exists (their generations are in memory,
  `worktree_catalog/service.rs:1029`, `git/broadcaster.rs:154`). The tool description
  says so.

Webhooks (X8) carry this cursor, so a receiver closes any gap with `changes_since`.

**Tests (fail first):** cursors increase strictly; entries hold no message text; a
transition written while the server was stopped and restarted is returned; `threadId`
filters; the scan cap returns progress; an old cursor reports `activityDropped`.

## Slice X4: Chat panels, panel messages, and UI intents

Status: Approved 2026-10-30 (user pre-approval; reviewed by Codex and advisor).

| Tool                 | Arguments                                                                                                         | Maps to                                                      | Hints     |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------- |
| `create_chat_panel`  | `hostThreadId`, `title?`, `providerInstanceId?`, `model?`, `runtimeMode?`, `purpose?`, `clientRequestId?`         | `worktree.createPanel` (receipt)                             | —         |
| `list_chat_panels`   | `hostThreadId`                                                                                                    | the shell projection: threads of kind `panel` with that host | read-only |
| `send_panel_message` | `fromThreadId`, `toThreadId`, `text`, `mode` (`queue` or `steer`), `includeLastReply` (false), `clientRequestId?` | `thread.turn.start` (queued) or `thread.turn.steer`          | —         |
| `focus_ui`           | `threadId`, `surface` (`thread`, `files`, `sourceControl`, `diff`), `path?`                                       | a new UI intent                                              | —         |

**`create_chat_panel`.** Its model and mode are resolved as `start_thread` resolves them,
capped by the ceiling. The `commandId` and `threadId` are frozen in the stored request, so
a retry replays by claim (`worktree_catalog_rpc.rs:1412-1421`). Every client adopts the
panel as an inactive tab (`centerPanelAdoption.ts:90-127`).

**`send_panel_message`.**

- Both threads must exist and share a host thread (the same `hostThreadId`, or one is the
  other's host), so they are in one worktree. Otherwise `McpNotSameWorktreeError`.
- The target is checked against the ceiling, as `send_message` is.
- With `includeLastReply`, the source's last assistant reply is appended as a quote,
  capped at 16,000 characters.
- The message records `sourceThreadId` (the column X1 adds), and the UI shows
  **From <panel title>** beside the agent chip. The server checks the source, so a client
  cannot point provenance at an unrelated thread.

**`focus_ui`.**

**Alternatives:**

- Move the client's layout to show the surface. That steals focus while a person types,
  which the issue forbids.
- The preview open request's claim model (`preview/mod.rs:483-536`), where the first
  client wins. Needed for opening a window once; not for a suggestion.
- **Chosen: an advisory intent.** `ui.publishIntent` (operate) puts
  `{ intentId, threadId, surface, path?, actor, createdAt }` on a new read stream,
  `subscribeUiIntents`. It is in memory, expires after 60 seconds, and allows 16 pending
  per thread. Every visible client showing that environment raises a non-modal toast,
  **Agent <label> wants to show <surface> · Show**; nothing moves until a person clicks
  **Show**. The result reports how many clients were subscribed.
- X7 adds a second intent kind to the same stream.

**Trust boundaries.** `path` is validated by C5. Titles and quoted replies are untrusted
text.

**Profiler.** One new RPC method and one stream, through the wrappers; no new process.

**Tests (fail first):** a panel created over MCP is adopted by a second client; a keyed
retry returns the same panel; `send_panel_message` across worktrees is refused; the
quoted reply is capped; the provenance renders; `focus_ui` raises a toast in a subscribed
client, moves nothing, and expires after 60 seconds; 17 pending intents are refused.

## Slice X5: Workspace files

Status: Approved 2026-10-30 with the Revision 4 requirements (user pre-approval; reviewed by Codex and the advisor).

All tools take `threadId`; the server resolves `cwd` (C5). Capability set `files`.

| Tool             | Arguments                                                        | Maps to                                                                             | Hints                       |
| ---------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------- |
| `files_list`     | `threadId`, `limit?` (200 at most)                               | `projects.listEntries`                                                              | read-only, idempotent       |
| `files_search`   | `threadId`, `query`, `limit?`                                    | `projects.searchEntries`                                                            | read-only, idempotent       |
| `files_read`     | `threadId`, `path`, `offset?`                                    | `projects.readFile`                                                                 | read-only, idempotent       |
| `files_write`    | `threadId`, `path`, `content`, `expectedVersion` or `createOnly` | `projects.writeFileIfUnchanged`                                                     | —                           |
| `files_create`   | `threadId`, `path`, `kind` (`file` or `directory`)               | `projects.createEntry`                                                              | —                           |
| `files_rename`   | `threadId`, `from`, `to`                                         | `projects.renameEntry` (refuses an existing target, `workspace/service.rs:469-473`) | —                           |
| `files_delete`   | `threadId`, `path`, `permanent` (false), `clientRequestId?`      | `projects.deleteEntry`, with a new `toTrash` option                                 | **destructive**             |
| `files_download` | `threadId`, `path`                                               | `projects.createDownloadUrl`                                                        | read-only                   |
| `files_upload`   | `threadId`, `directory`, `fileName`, `overwrite` (false)         | `projects.createUploadUrl`, with `overwrite` bound in the token                     | **destructive** (overwrite) |

**Decisions:**

- **Reads** return pages of at most 16,000 characters with `byteLength`, `truncated` and
  `version`. A file over the 1 MiB read cap, or a binary file, is refused for reading and
  writing (`workspace/service.rs:19`, `:278`); it can be downloaded.
- **Writes need a precondition.** `files_write` sends the `version` of a complete read,
  or `missing` with `createOnly`. A file changed since the agent read it is refused
  (`file_changed_on_disk`), so a write never loses an edit the agent did not see. Content
  is capped at 1 MiB, a new cap: the service has none.
- **Delete goes to the trash by default.** `deleteEntry` hard-deletes today
  (`workspace/service.rs:486-512`). X5 adds `toTrash` (default false, so the UI is
  unchanged) using the trash service `git_discard` uses, and `files_delete` sends it unless
  `permanent: true`, mirroring `git_discard`.
- **Transfers move no bytes through MCP.** `files_download` and `files_upload` return a
  transfer URL valid for 5 minutes (`transfer/mod.rs:15`), built on the base the agent
  reached. X5 ships the direct base: the bound address, loopback for a local relay or the
  `bibcode thread` CLI. Remote OAuth sessions do not exist until R, so R adds their
  base, the origin of the session's `mcp_resource`, as a one-line change in
  `mcp/tools/files.rs`.
  - The upload token binds `overwrite`; today it is a query flag anyone holding the URL
    can set (`production/http_routes.rs:705`). A token minted without it refuses
    `?overwrite=1`. The UI's tokens keep today's behavior.
  - Over `ssh <host> bibcode mcp` the URL is the host's loopback, which the agent cannot
    reach. The agent has SSH to that host already, so the description tells it to use
    `scp`; rebuilding file copy over MCP would duplicate what its own transport does.
  - Chunked transfers through MCP remain a follow-up if an agent has MCP but no other
    path to the host.
  - The URL is a short-lived capability in the agent's context. It reaches one file or
    one directory target, for 5 minutes, and only while the agent's access lasts (below).
- **An MCP-minted transfer ends with the agent's access (review P1, Revision 3).** Today
  the route trusts the signed token alone (`production/transfer_routes.rs:155`), so a
  URL would outlive **Stop**, revocation, read-only and the off switch. X5 binds it to
  the live controls F0 already defines (C4):
  - **The token names its session.** `TransferClaims::Upload` and `Download` gain an
    optional `mcp_session_id`, inside the signed claims, so it cannot be added or changed.
    The UI's tokens leave it out and behave exactly as today.
  - **The route checks access when the transfer starts.** For a token with a session, the
    session must be live (not revoked, so not stopped), `enableMcpServer` on, and the
    `files` capability on; an upload also needs a mutating ceiling, so read-only and
    **Take over** refuse it. A failed check answers like an expired token (404), so the
    route still confirms nothing about the path.
  - **The transfer runs under C4's cancellation token** for that session, built by an
    accessor on F0's live-control builder (`mcp/outcome.rs`). It fires on shutdown, on
    the settings watch (MCP off or `files` off; read-only and **Take over** fire it for
    uploads only), and on revocation through `mark_connected_guard`. A transfer takes no
    owned-mutation slot.
  - **An upload is checked again before its final rename.** `write_upload` streams into
    a partial file and renames it last (`transfer/upload.rs:221`). It selects on the
    token while it reads the body, and checks it once more just before the rename. A
    fired token removes the partial file and answers 404, so the target is never
    created or overwritten after access ends. A download's body stream ends when the
    token fires.
  - The one remaining window is between that last check and the rename, a single local
    system call. A transfer finished in that window writes its activity row like any
    other, so it is attributed.
- **Activity.** Every mutating call, and each MCP-minted transfer when the route finishes
  it, writes an activity row (X1), so the change shows who made it.

**Tests (fail first):** a read of a 2 MiB file is refused with the download hint; a write
with a stale `expectedVersion` is refused; `createOnly` on an existing file is refused;
`files_delete` trashes and `permanent: true` removes; a symlink escape is refused for
every tool; an upload URL minted without `overwrite` refuses `?overwrite=1`; a download
URL from a relay call uses the bound address; with `files` off the tools are hidden. (R
tests that a remote OAuth call gets its own origin.) For live access: an MCP-minted URL
used after revocation, after the off switch, or after `files` is turned off answers 404,
and an upload URL also does after read-only; revoking during an upload leaves neither
the target nor a partial file; a download stream stops on revocation; a UI-minted token
is unaffected by every switch.

## Slice X6: Clone

Status: Approved 2026-10-30 with the Revision 4 requirements (user pre-approval; reviewed by Codex and the advisor).

| Tool               | Arguments                                                                                       | Maps to                                                                         | Hints      |
| ------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------- |
| `clone_repository` | `url`, `parentProjectId`, `directoryName?`, `addAsProject` (true), `title?`, `clientRequestId?` | one owned mutation: `vcs.clone` (not detached), then `project.create` (receipt) | open world |
| `clone_status`     | `cloneId`                                                                                       | the clone's recorded outcome row (C4)                                           | read-only  |
| `cancel_clone`     | `cloneId`                                                                                       | cancels that owned mutation                                                     | —          |

**Where a clone may go (Question 8, resolved 2026-10-30).** The extended scope says
`parentPath` is "limited to the roots allowed in settings", but no such setting exists
(`production/host_paths.rs:24`).

- **Chosen:** `parentProjectId`. The clone goes next to that registered project, in its
  workspace root's parent. This keeps "ids, never paths", and puts the clone where the
  person already keeps projects.
- An absolute `parentPath` is not accepted, and no allow-list setting of clone roots is
  added.

**One owner for clone and registration (review P2, Revision 3).** A detached clone keeps
running after its caller leaves (`production/clone_operations.rs:5-6`, `:288`), and
nothing would own the later `project.create`. So the whole tool call is one C4 owned
mutation:

- **Always owned.** `clone_repository` always runs as an owned mutation, with or without
  a `clientRequestId`; without one the server mints the key. `cloneId` is that key. The
  recorded request, with the URL's destination and a frozen `projectId` and `commandId`,
  is the durable registration intent. The clone holds one owned-mutation slot (2 per
  session, 8 per environment) until it settles.
- **The task, not the call, runs both steps.** The owned task calls `vcs.clone` with
  `detach: false`. The handler's `cancellation` argument bounds only an attach's disk
  check (`clone_operations.rs:233-234`), so it does not stop Git. Instead, when C4's
  token fires, the task stops waiting and drops its `vcs.clone` future. With
  `detach: false` that trips the runtime's drop guard (`:288`), which cancels a clone
  this task started, and leaves alone a clone it only joined, such as one a person
  started in the UI. On success with `addAsProject`, the same task dispatches `project.create` with the
  frozen ids, as the web does after a clone (`useAddProjectWorkflow.ts:715-750`). A
  refusal because the root is already registered (`engine.rs:3958`) is returned as that
  project, so a retry never creates a second one. Then it writes the outcome.
- **The call waits up to 50 seconds,** then returns `{ state: "running", cloneId }`;
  `clone_status` reads the outcome row later, across reconnects.
- **Live controls.** The task runs under C4's token: the off switch, read-only,
  revocation, **Stop**, **Take over** and shutdown cancel the clone, and the clone
  runtime removes the folder it created. `cancel_clone` cancels the same token. A clone
  stopped before Git finished records `unknown` with the reason, as C4 does for any
  interruption, because Git may have finished at the same instant. Once Git has
  finished, registration is local and bounded, and it completes like C4's handler-owned
  steps.
- **Restart.** A row still `running` after a restart returns `McpOutcomeUnknownError`
  (C4). A retry with a new `clientRequestId` is safe: the runtime returns a finished
  clone of the same URL as `Existing` instead of cloning again, and registration then
  finds or creates the project.
- Progress for other clients comes from the activity row (X1) and then `project.created`.

**Which hosts an agent may clone from (review P2, Revision 3).** Without a policy, an
operate client could make the server reach loopback or private hosts that the client
itself cannot reach. **Chosen: public hosts only, for any clone an `mcp-client` principal
starts.** `vcs.clone` and `sourceControl.cloneRepository` read the principal from their
context (`register_unary_with_context`, as `orchestration.dispatchCommand` does), so an
agent cannot avoid the policy by calling the RPC directly; a person's clone in the UI is
unchanged. A new `git/clone_policy.rs` checks, and `ReservedClone::transfer`
(`git/repository.rs:7376`) applies what it decides:

- **Shape.** The URL must be `https://` or SSH form, with no user information (no
  `user:token@`), so a credential never sits in tool arguments. It is never logged.
- **Git's own rewrites first.** `git ls-remote --get-url <url>` expands
  `url.<base>.insteadOf` without contacting the remote (git-ls-remote(1)). The expanded
  URL must still be `https` or SSH, and the host checks below apply to it. Git applies
  the same rewrite again when it clones, so the checked host is the one it contacts.
- **Allowed protocols.** The clone runs with `-c protocol.allow=never`,
  `-c protocol.https.allow=always` and `-c protocol.ssh.allow=always`. Git applies this
  policy to the rewritten URL too (git-config(1), `url.<base>.insteadOf`), so a rewrite to
  `file:` or `ext::` fails.
- **HTTPS: resolved, checked, pinned.** The host is resolved once. Every address must be
  public: loopback, private, link-local, CGNAT (`100.64.0.0/10`), unique-local,
  multicast and unspecified addresses are refused, including IPv4-mapped forms, the same
  list X8 uses. The clone then runs with `-c http.curloptResolve=<host>:<port>:<address>`,
  so Git connects to the checked address and DNS rebinding cannot move it, and with
  `-c http.followRedirects=false`, so a redirect cannot take it to another host. A
  repository that moved and now redirects fails with a typed error naming the redirect,
  and the agent retries with the new URL.
- **SSH: checked, guarded by the host key.** `ssh -G <host>` gives the effective
  `hostname` and `port` after the person's SSH config. The clone is refused when that
  config sets `ProxyCommand` or `ProxyJump`, when `core.sshCommand`, `GIT_SSH` or
  `GIT_SSH_COMMAND` replaces `ssh` (BiBCode cannot see where those connect), or when
  `StrictHostKeyChecking` is `no` or `accept-new`. The hostname must resolve to public
  addresses only. SSH resolves the name again itself, so the address is not pinned;
  rebinding is caught instead by the host key check, which compares the key with the one
  known for that hostname, and with `yes` or `ask` (the default) a non-interactive clone
  never accepts an unknown key.
- **Refusal.** A refused host returns `clone_host_refused`: "BiBCode does not clone from
  local or private network addresses for an agent. Clone it in BiBCode yourself." No
  setting widens this.
- **Versions.** `http.curloptResolve` needs the Git release that added it (2.37, to be
  confirmed against Git's release notes in X6). Git ignores an unknown `-c` key, so an
  older Git would silently skip the pin; X6 refuses an HTTPS agent clone on an older Git
  with a typed error naming the version.

**Trust boundaries.** Clone runs Git against an outside URL; hooks do not run on clone.
The destination is always a sibling of a registered project, and the source is a public
host. A configured HTTP proxy resolves the name itself, so behind a proxy the check
covers the local answer only; this is a stated residual risk.

**Profiler.** No new process path: `git ls-remote --get-url`, `ssh -G` and the clone run
through the existing supervised repository layer, each bounded by a timeout.
`mcp.clone_repository` is long-running through `vcs.clone`, and holds no wait slot.

**Tests (fail first):** with a test-only policy that admits the fixture, a clone from a
local bare repository next to a project registers it; a URL with user information is
refused; a destination holding anything but a finished clone of the same URL is
refused, while such a clone is registered without cloning again (`Existing`,
`git/repository.rs:7356`); a call past 50 seconds returns `running` and `clone_status`
later returns the project; dropping the task's `vcs.clone` future stops Git; `cancel_clone`, revocation and the off
switch each stop a clone the agent started and remove its folder, and leave a clone a
person started running; a keyed retry creates one project; a retry after a restart
registers the finished clone without cloning again. For hosts: `https://127.0.0.1/`,
`https://10.0.0.1/`, a name resolving to `::1`, an `insteadOf` rewrite from a public URL
to a private one, a rewrite to `file://`, and a redirect are each refused; an SSH host
whose config sets `ProxyJump` or `StrictHostKeyChecking accept-new` is refused; the
pinned address is the one Git connects to; a person's UI clone of a private host still
works.

## Slice X7: Source Control reads and the commit message suggestion

Status: Approved 2026-10-30 (user pre-approval; reviewed by Codex and advisor).

**Reads** (capability `sourceControl`, read-only, idempotent):

| Tool       | Arguments                                 | Maps to                                              |
| ---------- | ----------------------------------------- | ---------------------------------------------------- |
| `git_diff` | `threadId`, `path?`, `staged?`, `cursor?` | `gitManager.getDiff` (`rpc/methods.rs:86`)           |
| `git_log`  | `threadId`, `ref?`, `limit?`, `cursor?`   | `gitManager.getCommits` (`:85`)                      |
| `git_refs` | `threadId`                                | `gitManager.getRefs` and `getStashes` (`:87`, `:89`) |

Diff pages are at most 16,000 characters and untrusted. Verify each method's input shape
in implementation.

**`git_generate_commit_message { threadId, paths? }`** maps to `vcs.generateCommitMessage`.
It is deterministic ("Update <paths>", `production/git_vcs.rs:3316`); the description says
so, and that an agent usually writes a better message itself.

**`git_set_commit_message { threadId, message }`** (at most 8,000 characters).

**Alternatives:**

- Not offered: `git_commit` already takes the message.
- A server-side draft store that replaces the browser draft. That changes a working panel
  for every person, and needs a migration and a sync model.
- **Chosen: a suggestion.** A second intent kind on X4's `subscribeUiIntents`,
  `commitMessage { cwd, message, actor }`, kept in memory as the last one per `cwd` for
  24 hours, so a panel opened later still gets it.

**UI.** When the suggestion's `cwd` matches the Source Control panel:

- an empty draft is filled, with **Message from Agent <label>** under it;
- a draft with text is never overwritten (UI.md: preserve user work); the panel shows
  **Agent <label> suggested a message · Use it · Dismiss**.

**Tests (fail first):** the reads return capped, untrusted text; a suggestion fills an
empty draft in a second client; a non-empty draft is kept and offered **Use it**; a panel
opened after the suggestion still receives it.

## Slice X8: Outbound webhooks and the Agent integrations tabs

Status: Approved 2026-10-30 with the Revision 4 requirements (user pre-approval; reviewed by Codex and the advisor).

**Current behavior.** No webhook code exists. `reqwest` and `hmac` are dependencies, and
`SecretStore` keeps 0600 plaintext files (see "Webhooks" above).

**Settings.**

- **Agent integrations** gains two tabs, **MCP** and **Webhooks**, under the existing
  environment picker (`diagnosticsEnvironment.tsx:26-69`).
- A status line in the section header: MCP on or off, connected agents, active and failing
  endpoints.
- `enableWebhooks` (default **off**) joins `ServerSettings`.

**Endpoints.** At most 20 per environment, each with a name, an HTTPS URL, an enabled
flag, event filters by category and type, an optional project filter, and an optional
paired MCP client. Its secret is generated, shown once, rotatable, and kept in
`SecretStore` as `webhook-<id>`; it is plaintext at rest like the host identity secret,
and never in settings, client state or logs.

**Events.**

| Event                                                                                                   | Source                                                |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `thread.status_changed`, `worktree.created`, `panel.created`, `approval.requested`, `approval.resolved` | orchestration events, through X3's transition mapping |
| `clone.completed`, `scm.operation_completed`, `transfer.completed`, `transfer.failed`                   | activity rows (X1): operations an agent ran           |
| `profiler.finding`                                                                                      | the profiler's findings, read through its `Reader`    |
| `webhook.test`                                                                                          | **Send test event**                                   |

Two catalog entries are dropped: `server.health_changed` (the server has no health
state to change) and `diagnostics.bundle_ready` (bundles are built on request, never in
the background).

**Payload.** `{ id, type, occurredAt, environmentId, threadId?, worktreeId?, actor?,
cursor?, finding? }`. Every event from X3's two sources carries `cursor`, X3's.
`profiler.finding` carries `finding: { id, count, lastSeen }` instead, because findings
are not in X3's feed. No prompt, message, file, diff, token or secret; any text field
goes through `redact_sensitive_text`.

**Gap recovery (review P2, Revision 3).** Every event type has a durable catch-up read,
and X3 is unchanged:

- **Events and activity:** `changes_since { cursor }` (X3), with the last `cursor` the
  receiver processed.
- **Findings:** X2's `profiler_findings { since }`, with the `lastSeen` of the last
  finding the receiver processed. `since` is inclusive ("at or after",
  `diagnostics/profiler/reader.rs:162-178`), so a finding seen in the same second is not
  missed; the receiver drops repeats by `id` and `count`. The findings book keeps at most
  1,000 findings, and one call returns up to 10,000, so one call covers a gap.
- `profiler.finding` is offered only while the `diagnostics` capability set is on, so its
  recovery tool always exists. The receiver guide names each recovery read.
- **Alternative not taken:** a third component in X3's cursor for findings. That changes
  an approved slice for one event type, and findings have no sequence: they are a
  compacted book keyed by id, rewritten in place (`diagnostics/profiler/findings.rs:139-153`).

**Delivery.**

- **Source.** A `WebhookDispatcher` service follows three durable sources, each from a
  stored position: the event sequence and the activity ids (X3's two), and, for
  findings, the `lastSeen`, `id` and `count` it last delivered. A finding is delivered
  when it appears or its count rises, as `Reader::follow_findings` reports
  (`reader.rs:322`). It never uses the in-process broadcast, which drops events under
  load (`engine.rs:2013`).
- **Queue.** `webhook_deliveries` rows are durable, so a restart resumes them. At most
  10,000 are pending; past that the oldest are abandoned with a warning, and a receiver
  recovers through the reads above.
- **Request.** HTTPS only, or loopback `http` with a per-endpoint opt-in. Headers:
  `X-BibCode-Event`, `X-BibCode-Delivery`, `X-BibCode-Timestamp`, and
  `X-BibCode-Signature: v1=<hex HMAC-SHA256(secret, timestamp + "." + body)>`. A 10-second
  timeout, no redirects followed, and the response body is not kept.
- **SSRF.** The host is resolved once per attempt, and loopback, private, link-local and
  CGNAT addresses are refused (loopback only with the opt-in); the connection uses the
  resolved address, so DNS rebinding cannot redirect it.
- **Retries.** 5 attempts over about 30 minutes (30 s, 2 min, 5 min, 10 min, 15 min) on a
  timeout, connection error, 5xx or 429. Other 4xx responses fail at once.
- **Health.** 10 consecutive failed deliveries disable the endpoint, with a warning and a
  **Re-enable** button.
- **Off is immediate.** Turning webhooks off, or disabling an endpoint, cancels its
  in-flight request and leaves the rest queued as abandoned.
- **Pairing.** Revoking a paired MCP client disables its endpoints, with a warning in both
  tabs (the dispatcher listens for `AuthAccessChange::ClientRemoved`,
  `auth/service.rs:1954`).

**Administration.** `webhooks.list`, `listDeliveries` (`access:read`) and `upsert`,
`delete`, `rotateSecret`, `sendTest`, `redeliver` (`access:write`). An `mcp-client`
session never holds an `access:*` scope, so agents cannot configure webhooks, like the
other settings.

**Webhooks tab.** The on/off switch, the endpoint list (add, edit, disable, delete), the
secret shown once with **Copy**, the filters, **Send test event**, and per endpoint the
recent deliveries (time, type, status, attempts, latency) with **Redeliver**. Deleting an
endpoint asks for confirmation, since its delivery log goes with it; nothing else does.

**Persistence.** The X8 migration: `webhook_endpoints`, `webhook_deliveries` (kept 7
days, or the last 1,000 per endpoint), and `webhook_state` (the dispatcher's three
positions).

**Profiler.**

- Outbound HTTP is not a child process.
- The new RPC methods go through the wrappers; `webhooks.sendTest` and
  `webhooks.redeliver` wait on a network, so they join `is_long_running`.
- A failed delivery logs `tracing::warn!` with the endpoint id and status, never the URL,
  which may carry a token.
- The dispatcher stops in the quiesce sequence before the profiler's teardown.

**Tests (fail first):** a signed delivery verifies with the secret over its
`X-BibCode-Timestamp` (the receiver guide documents the 5-minute window); retries follow the
schedule on 500 and stop on 400; the queue resumes after a restart; a private address is
refused; a payload contains no message text; disabling an endpoint stops its delivery;
revoking a paired client disables its endpoints; a receiver that drops every second
delivery still sees every transition through `changes_since`, and every finding through
`profiler_findings { since }`, including two findings recorded in the same second; with
`diagnostics` off no `profiler.finding` is delivered.

## Slice R: Remote Streamable HTTP with MCP OAuth

Status: Approved 2026-10-30 with the Revision 4 requirements (user pre-approval; reviewed by Codex and the advisor).

R lands last among the code slices. It inherits F0's `production/connect_mcp.rs` and the
`bibcode thread` CLI's `lib.rs` and `config.rs` edits, which land on the batch branch
first.

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
- **Loopback redirects (RFC 8252 §7.3).** The authorization server MUST allow any port in
  a loopback redirect URI, because native clients pick one at run time.
- **Streamable HTTP.**
  - Servers MUST validate `Origin`, and answer an invalid one with 403.
  - There are no sessions and no GET stream in 2026-07-28.
  - 2025-11-25 sessions are optional for the server.

### Harness facts (design inputs)

**Codex** (source read at `rust-v0.165.0`, crate `codex-rs/rmcp-client`, and the `rmcp`
revision it pins, `98a54789`, file `crates/rmcp/src/transport/auth.rs`; installed CLI
0.165.0):

- **Discovery.** It first sends an unauthenticated request to the MCP URL and reads
  `resource_metadata` from a 401 (`auth.rs:2925-2944`), then tries the RFC 9728
  well-known paths and RFC 8414 on each named authorization server (`auth.rs:1341-1366`,
  `:2486-2513`). PRM `resource` must be a prefix of the configured URL, and the issuer
  must match (`auth.rs:2615`, `:2775-2833`).
- **`codex mcp add <name> --url <url>`** probes discovery and starts the browser flow
  itself when metadata is published; otherwise it says to run `codex mcp login <name>`
  (`cli/src/mcp_cmd.rs:463-492`). A metadata-less fallback counts as "unsupported"
  (`rmcp-client/src/auth_status.rs:254-258`).
- **Registration.** `Auto` picks a pre-registered `--oauth-client-id`, else CIMD when the
  server advertises it with `none` auth, else DCR (`oauth_client_registration.rs:53-110`).
  DCR sends `client_name: "Codex"`, `token_endpoint_auth_method: "none"`, and
  `grant_types: [authorization_code, refresh_token]` (`auth.rs:1757-1800`).
- **Redirect URI.** `http://127.0.0.1:<random port>/callback/<id>`, or `/callback` when
  the server advertises `iss` support, with a new port each login
  (`perform_oauth_login.rs:474-483`, `oauth_callback.rs:52-102`).
- **`resource`** is sent on the authorize, token and refresh requests, with the PRM's
  value (`auth.rs:1892`, `:2205`, `:2371-2373`, `:1927-1932`).
- **Refresh.** It refreshes proactively within 30 seconds of `expires_in` before each call,
  and once on a 401 before retrying (`rmcp-client/src/oauth.rs:1043-1054`,
  `rmcp/src/transport/common/auth/streamable_http_client.rs:36-67`). It stores a rotated
  refresh token (`refresh_transaction.rs:381-396`). On `invalid_grant`, or with no refresh
  token, it never opens a browser: the server fails with "Run `codex mcp login <name>`"
  (`codex-mcp/src/connection_manager/startup.rs:120-126`).
- **`iss`** is required when the server advertises it, and a mismatch is always refused
  (`auth.rs:2141-2175`).
- **Scopes.** `--scopes`, then configured scopes, then the 401 challenge's `scope`, then
  PRM `scopes_supported`; `offline_access` is appended only when listed; a refused scope
  set is retried with none (`codex-mcp/src/mcp/auth.rs:161-193`,
  `cli/src/mcp_login.rs:67-127`).
- **403 `insufficient_scope`** is not stepped up; the call just fails
  (`http_client_adapter.rs:300-310`, `startup_error.rs:19-95`).
- **Blocked hosts.** An authorization server on a loopback, private, link-local or
  `100.64.0.0/10` IP literal is refused unless the MCP server is itself loopback
  (`auth.rs:1244-1313`). A Tailscale `100.x` address therefore fails; its MagicDNS name
  does not.
- **HTTPS** is not required by Codex.
- **Progress.** `rmcp` gives every request a `progressToken` (`rmcp/src/service.rs:887-899`).
  Progress is only logged and does not extend the 300-second default tool timeout
  (`logging_client_handler.rs:63-71`, `codex-mcp/src/rmcp_client.rs:114-115`). This
  settles slice 1's open question on Codex progress tokens.

**Claude Code** (its MCP docs, read 2026-10-30):

- PRM, then RFC 8414 discovery; DCR, CIMD, and `--client-id`/`--callback-port`
  pre-registration.
- Redirect `http://localhost:<random port>/callback`, or a fixed port with
  `--callback-port`.
- "Authentication tokens are stored securely and refreshed automatically." On a 401 it
  refreshes, reconnects and retries once; when the refresh token is refused it asks the
  person to **Re-authenticate** in `/mcp`. `offline_access` is appended only when listed.
- Credentials go only to an HTTPS or loopback token endpoint, and an unexpected `iss` is
  refused.
- `403 insufficient_scope` fails the call; re-authenticating requests the pinned
  `oauth.scopes`, not the scope the server named.
- `claude -p` and Agent SDK runs cannot complete OAuth: sign in interactively first.
- The HTTP idle window is 5 minutes, reset by progress; calls past 2 minutes move to a
  background task.

**What R does with them:**

1. **Answers an unauthenticated `/mcp` request with 401 and `resource_metadata`**, for GET
   as well as POST. An authenticated GET stays 405. Codex's first probe and
   `codex mcp add` then work.
2. **Matches loopback redirect URIs on scheme, host and path, with any port.** Both
   harnesses use a new random port per login. HTTPS redirect URIs match exactly.
3. **Issues one-hour access tokens with `expires_in`, and rotating refresh tokens.** Both
   harnesses refresh before expiry and store the rotated token. Neither reopens a browser
   by itself, so without refresh tokens every agent would stop each hour.
4. **Issues the refresh token without `offline_access`.** It is not listed, so neither
   harness asks for it; a request that includes it anyway is accepted and the scope
   ignored.
5. **Treats an empty scope request as the default pair** (`orchestration:read
   orchestration:operate`), which is what Codex sends after a refused scope set.
6. **Advertises `iss` support and sends `iss`.** Codex then uses `/callback`, and both
   check it.
7. **Keeps `issuer` stable as the origin**, because Codex binds stored refresh tokens to
   it.

### Alternatives

| Choice                      | Options                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Decision                                                                                                                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transport auth              | R1 MCP OAuth; R2 static bearer in the harness config (not conformant, and it parks a 30-day operate token in a file)                                                                                                                                                                                                                                                                                                                                     | **R1** (slice 1's answer)                                                                                                                                                                                |
| Authorization server        | BiBCode as its own authorization server on the same origin; an external one (the Connect relay, Clerk)                                                                                                                                                                                                                                                                                                                                                   | **Same origin.** The environment owns its sessions (`remote.md`: the relay "does not become the owner of environment sessions")                                                                          |
| Client registration         | DCR; CIMD (the server fetches the client's HTTPS metadata, so it needs an SSRF-safe fetcher); a pre-registered id issued in Settings                                                                                                                                                                                                                                                                                                                     | **DCR now** (Question 5). Both harnesses use it when CIMD is not advertised. **CIMD is a follow-up** for the 2026-07-28 SHOULD                                                                           |
| Consent                     | (a) type a pairing code on the consent page (the upstream project's model; BiBCode's pairing codes are long base64 blobs, `auth/pairing_code.rs`); (b) the consent page needs a BiBCode cookie session; (c) **approve in BiBCode**: the page shows a short code, and any BiBCode client with `access:write` on that environment shows a card with the same code to approve or deny, with `bibcode mcp authorize <code>` on the host as the headless path | **(c)** (Question 4), bound to the exact client, redirect URI, resource and requested scopes. Nothing to remember or type (UI.md), and the decision stays in an authenticated BiBCode surface            |
| Token lifetime              | (a) the existing 30-day session as the bearer, no refresh token; (b) one-hour access token and a rotating refresh token; (c) one-hour access token and reauthorization on expiry                                                                                                                                                                                                                                                                         | **(b)** (Question 6). (a) leaves a stolen bearer usable for 30 days (review P2). (c) would stop every agent each hour, because neither harness reauthorizes by itself. Both harnesses refresh and rotate |
| Redirect URI matching       | exact string; exact with any port for loopback                                                                                                                                                                                                                                                                                                                                                                                                           | **Any port for loopback** (RFC 8252 §7.3); exact for HTTPS                                                                                                                                               |
| Where the origin comes from | the rewritten `Host` and `X-Forwarded-*` from any loopback peer (today); a new configured public origin; **what the server knows**: direct loopback, its own managed hostname, or a local proxy that overwrites the forwarded headers                                                                                                                                                                                                                    | **What the server knows** ([Origins](#origins-and-forwarded-headers)). It needs no new setting, and it does not depend on headers this repository cannot prove a client is unable to set                 |
| Plain HTTP on a LAN address | serve OAuth anyway; refuse                                                                                                                                                                                                                                                                                                                                                                                                                               | **Refuse.** The spec requires HTTPS for authorization endpoints, and Claude Code refuses a non-loopback `http` token endpoint. Plain-HTTP environments keep `ssh <host> bibcode mcp`                     |
| A new setting               | `mcpRemoteHttp` on or off; gate on `enableMcpServer` only                                                                                                                                                                                                                                                                                                                                                                                                | **No new setting.** Every grant still needs approval in BiBCode, and the unauthenticated routes only create bounded, expiring rows                                                                       |

### Origins and forwarded headers

**What source shows.** The managed tunnel's connector runs on the host, so its requests
come from a loopback peer. The relay's ingress routes only the listed hostnames and ends
with `http_status:404`, with no `originRequest` override
(`ManagedEndpointProvider.ts:741-753`), and the preview gateway already identifies tunnel
traffic by its `Host` (`preview/gateway/relay.rs:85-91`). The public hostname therefore
arrives in `Host`. Whether the edge removes a `X-Forwarded-Host` or `X-Forwarded-Proto`
that the client sent is not visible here, so R must not depend on either for the tunnel.

Today `apply_forwarded_headers` trusts both headers from **any** loopback peer
(`http.rs:191-208`). Through the tunnel, a client that sends `X-Forwarded-Host: 127.0.0.1`
would therefore turn its `Host` into a loopback name (review P2).

**The rule, in `http.rs`, for every route:** `X-Forwarded-Host` and `X-Forwarded-Proto` are
honored only when the peer is loopback **and the raw `Host` is a loopback name or the
bound address**. Otherwise both are removed and `Host` is kept.

- The documented nginx recipe keeps working: nginx sends `Host: $proxy_host`
  (`127.0.0.1:3773`) and overwrites both headers with `proxy_set_header`
  (`docs/user/remote-access.md:82-96`), so a client's own values never reach the server.
- Through the tunnel the raw `Host` is the public hostname, so injected headers are
  dropped.
- A proxy that sends the public `Host` itself loses only `X-Forwarded-Proto`, so it is not
  eligible for OAuth until it follows the recipe. The runbook says so.

**Request classes**, computed once per request:

| Class          | Condition                                                                                                                        | Effective origin                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Direct         | raw `Host` is a loopback name or the bound address, and no forwarded header was present (the rule at `connect_mcp.rs:1609-1612`) | `http://<Host>`                                       |
| Managed tunnel | loopback socket, and `Host` names the managed hostname in `RelayHosts`                                                           | `https://<managed hostname>`, fixed by the server     |
| Local proxy    | loopback peer, loopback raw `Host`, and `X-Forwarded-Host` present                                                               | `<X-Forwarded-Proto, else http>://<X-Forwarded-Host>` |
| Other          | anything else, including a preview gateway hostname                                                                              | none                                                  |

An **eligible origin** for the OAuth routes is a managed tunnel, a local proxy with
`https`, or a direct request (loopback `http`, as the spec allows).

**Audience on `/mcp` (review P2):**

- A **provider token** is accepted only on a direct request. Providers are given the
  bound address (`lifecycle.rs:918-931`), so a provider token that leaked cannot be used
  through the tunnel or a proxy.
- A **relay or CLI session** (`mcp_resource` NULL) is accepted only on a direct request.
  The relay dials loopback (`mcp/endpoint.rs`).
- An **OAuth session** is accepted only when the request's effective `<origin>/mcp`
  equals its `mcp_resource`.
- Anything else gets 401.

A token minted through one hostname does not work through another, and a tunnel hostname
change requires a new authorization. This is intentional (RFC 8707 audience).

### Routes

Every metadata value below is computed from the request's effective origin. Every OAuth
route answers 404 when the origin is not eligible.

- **`GET /.well-known/oauth-protected-resource/mcp`** and
  **`GET /.well-known/oauth-protected-resource`** return:
  - `resource: "<origin>/mcp"`;
  - `authorization_servers: ["<origin>"]`;
  - `scopes_supported: ["orchestration:read", "orchestration:operate"]`, plus
    `terminal:operate` while `mcpCapabilities.terminals` is on;
  - `bearer_methods_supported: ["header"]`;
  - `resource_name`: the environment label.
- **`GET /.well-known/oauth-authorization-server`** returns:
  - `issuer: "<origin>"`;
  - `authorization_endpoint`, `token_endpoint` (`/oauth/token`) and
    `registration_endpoint`;
  - `response_types_supported: ["code"]`,
    `grant_types_supported: ["authorization_code", "refresh_token"]`;
  - `code_challenge_methods_supported: ["S256"]`,
    `token_endpoint_auth_methods_supported: ["none"]`;
  - the same `scopes_supported`;
  - `authorization_response_iss_parameter_supported: true`.
- **`POST /oauth/register`** (RFC 7591):
  - **Clients.** Public clients only (`token_endpoint_auth_method: "none"`).
  - **Other fields.** `grant_types` and `response_types` are accepted when they are within
    what the metadata advertises (Codex sends `[authorization_code, refresh_token]` and
    `[code]`); `application_type`, `scope` and unknown fields are accepted and ignored
    (RFC 7591 §2). A strict refusal would turn Codex's registration away.
  - **`redirect_uris`.** One to five, each `http://localhost|127.0.0.1|[::1][:<port>]/…`
    or `https://…`, with no fragment. A loopback URI's port is not part of its identity.
  - **`client_name`.** Up to 100 characters, shown as untrusted text.
  - **Storage and limits.** A row in `mcp_oauth_clients`, under the
    [admission limits](#admission-for-unauthenticated-routes). Clients that were never
    approved are pruned after 24 hours, and approved ones after 90 days unused.
  - **Response.** `client_id`, `client_id_issued_at`, `redirect_uris`, `client_name`,
    `token_endpoint_auth_method`.
- **`GET /oauth/authorize`** validates before it redirects anywhere:
  - the client and the redirect URI (loopback port free, otherwise exact); on failure it
    shows an error page and never redirects;
  - `response_type=code`;
  - `code_challenge_method=S256` with a 43–128 character challenge;
  - `resource` equals `<origin>/mcp` exactly (case-insensitive scheme and host);
  - the requested scopes are within `scopes_supported`, with `offline_access` ignored
    and an empty request meaning the default pair.

  Then it creates a pending authorization in `mcp_oauth_authorizations`:
  - an id, and a `user_code` of 8 characters from an unambiguous alphabet, shown as
    `XXXX-XXXX`;
  - the client, the exact redirect URI including its port, the challenge, `state`, the
    resource, the requested scopes, the effective origin, and the source key;
  - expiry after 10 minutes, under the admission limits.

  It answers with the consent page (below).

- **`GET /oauth/authorize/status?id=…`** is the page's own poll, read with the cookie the
  page set:
  - **pending:** it refreshes;
  - **approved:** a 303 to `redirect_uri?code=…&state=…&iss=<origin>`;
  - **denied:** `error=access_denied&state=…&iss=…`;
  - **expired:** an error page.

  The status cookie is an HttpOnly, `SameSite=Strict` random value bound to the pending
  row, so another page cannot read the code.

- **`POST /oauth/token`** dispatches on `grant_type`. The eligibility rule applies to the
  new grants only (review P2):
  - **`urn:ietf:params:oauth:grant-type:token-exchange`** (RFC 8693, today's only grant,
    `auth/http.rs:40`, `:119-140`) is **unchanged**, on every origin it serves today.
  - **`authorization_code`**, with `code`, `code_verifier`, `redirect_uri`, `client_id` and
    `resource`, on an eligible origin:
    - the code is single use and valid for 60 seconds; its PKCE S256 must verify; its
      client, exact redirect URI, resource and scopes must match what was approved;
    - exchange mints the grant: an `mcp-client` session through the existing session
      writer, with the approved scopes and `mcp_access`, `mcp_resource` set, label
      `MCP · <client_name> (remote)`, method bearer, and an expiry 30 days after its last
      refresh;
    - the response is `{ access_token, token_type: "Bearer", expires_in: 3600,
      refresh_token, scope }`;
    - a second use of a code revokes the session it minted (RFC 6749 §4.1.2).
  - **`refresh_token`**, with `refresh_token`, `client_id` and `resource`, on an eligible
    origin:
    - in one SQLite transaction, the presented token must be unused, its session live,
      and its client and resource the grant's; it is marked used, and a new access token
      and refresh token are returned; the session's expiry moves to 30 days from now;
    - `scope`, if sent, may only narrow the grant; it never widens it;
    - **reuse (review P2, Revision 3):** a refresh token works once. Any second use, at
      any time, is refused with `invalid_grant` and revokes the whole grant, so both
      the thief and the agent must sign in again and the theft is visible (RFC 9700
      §4.14.2). There is no grace window and no cached rotation result: returning the new
      pair to a replay would hand a thief the grant undetected. Sender-constrained tokens
      (DPoP) would make a grace window safe, but Codex's MCP client has no DPoP code
      (`rmcp-client` and `codex-mcp` at rust-v0.165.0; the pinned `rmcp` crate was not
      reread), so there is nothing to bind to;
    - **why strict reuse does not break the harnesses:** Codex serializes every refresh
      across processes with a file lock, and rereads the stored credential under that
      lock before refreshing, so a second process adopts the winner's rotated token and
      never replays the old one (`rmcp-client/src/oauth/refresh_lock.rs:1-5`,
      `refresh_transaction.rs:104-130`). Claude Code's docs say it refreshes
      automatically; whether two of its processes can refresh one token at once could
      not be verified. If they do, the result is a **Re-authenticate** prompt, never
      access for anyone else. A response lost after the server rotated has the same
      result;
    - refresh still works while `enableMcpServer` is off, so turning MCP back on does not
      force every agent to reauthorize; `/mcp` refuses their calls meanwhile.
  - **Access tokens** are `SessionClaims` with `exp` one hour out (`auth/token.rs:73-85`),
    as DPoP sessions already are (`auth/service.rs:41`). Revoking the session ends both
    tokens at the next request.
- **`POST /api/auth/mcp-authorizations/{id}/approve`** with `{ access, terminals }`, and
  **`/deny`**:
  - They need `access:write`, like the other `/api/auth/*` administration routes.
  - `access` is at most the current `mcpServerAccess`.
  - `terminals` is allowed only when the client asked for `terminal:operate` and slice T's
    conditions hold. Unchecking it narrows the grant; nothing widens it.
  - The pending list reaches clients on the existing `subscribeAuthAccess` stream, as a
    new optional `pendingMcpAuthorizations` field.
- **Host CLI.** `bibcode mcp authorize [<code>] [--access <level>] [--terminals] [--deny]`
  works through the data root, the same authority as `bibcode pairing issue`.
  - With no code it lists the pending requests.
  - `<desktop exe> mcp authorize` is dispatched after `crash::attach()`, like `mcp`.

### Admission for unauthenticated routes

Registration and authorization are open, so they must not let one caller lock out others
(review P2).

- **Source key.** The same key the existing pre-auth admission uses: the peer address, or
  for a loopback peer the last `X-Forwarded-For` entry, bucketed by network
  (`docs/architecture/remote.md:320-336`). Managed-tunnel requests form their own source
  class.
- **Limits:**
  - per client: 2 pending authorizations;
  - per source: 8 registrations an hour, and 4 pending authorizations;
  - global: 64 never-approved clients and 64 pending authorizations, of which 16 are held
    back for sources that have none pending.
- **When the global cap is full**, a new request evicts the oldest pending entry of the
  source with the most; a source alone at its own cap gets 429. A flood from one source
  therefore evicts its own entries, not another source's.
- **Residual.** Through the managed tunnel this repository cannot prove the source key is
  unforgeable, so a flood through the tunnel can delay authorizations that also arrive
  through the tunnel. It cannot grant access, and it cannot exclude direct, SSH or proxy
  requests. Turning MCP off ends it.

### `/mcp` changes

- **401 challenge.** On an eligible origin, a 401 carries
  `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp", scope="orchestration:read orchestration:operate"`,
  for an unauthenticated POST and GET alike. A provider never sends a request without its
  token, so providers see no difference. `terminal:operate` is never in the challenge; an
  agent asks for it explicitly (Question 3).
- **Audience** is checked as set out in [Origins](#origins-and-forwarded-headers), for all
  three bearer kinds.
- **Origin.** The existing 403 for a foreign `Origin` stays. A DNS-rebinding page sends
  its own `Origin`, so it gets 403. The consent page sends `frame-ancestors 'none'`,
  `X-Frame-Options: DENY`, and a CSP with no script.
- **Legacy session shape.**
  - Providers keep `initialize` and `Mcp-Session-Id` (slice 1).
  - OAuth clients are sessionless in both eras, as relay clients already are.
  - `DELETE /mcp` from a client principal gets 405. An authenticated GET stays 405.
- **Insufficient scope.** A tool the credential lacks is hidden from `tools/list` and
  refused as a typed `McpScopeError` tool result naming the reauthorization step. It is
  not refused with HTTP 403 `insufficient_scope`: neither harness steps up by itself.

**Gaining the terminal scope later** means reauthorizing with it requested (Question 3):

- Codex: `codex mcp login bibcode --scopes orchestration:read,orchestration:operate,terminal:operate`.
- Claude Code: set the server's `oauth.scopes` to
  `"orchestration:read orchestration:operate terminal:operate"`, then **Re-authenticate**
  in `/mcp`.

### Tunnels and relays

- **BiBCode Connect's managed tunnel** gives an environment an HTTPS hostname, so remote
  MCP works there, with the origin fixed by the server
  ([Origins](#origins-and-forwarded-headers)).
- **A reverse proxy** on the host that follows the nginx recipe, or `ssh -L` to loopback,
  also gives an eligible origin. **Tailscale Serve** is eligible only if it presents as
  that recipe does (loopback `Host` plus both forwarded headers); this is unverified, and
  the runbook says to check it or use nginx. Use the MagicDNS name, never a `100.x`
  address, which Codex refuses.
- **The Connect relay's own tokens** never reach `/mcp`. They are not `mcp-client`
  sessions, and `/mcp` accepts no other session.
- **Preview gateway hostnames** never serve these routes.

### Trust boundaries

- **Who can grant access.**
  - The unauthenticated routes (register, authorize, status, token) grant nothing by
    themselves. Approval needs `access:write` in BiBCode, or the data root.
  - The approval card names the client, the redirect host ("Returns to
    `localhost:53682`"; the spec says the host MUST be displayed), the origin the request
    used, the scopes asked for, and the matching code.
  - When the redirect URI is localhost only, the card warns "Only approve if you just
    started this in an AI tool on that computer.", as the spec's localhost-impersonation
    note asks.
- **What the tokens reach.** The access token reaches only `/mcp` at that resource, within
  the approved scopes and the lower of its ceiling and the environment's, for one hour.
  The refresh token reaches only the token endpoint, for that client and resource.
- **Abuse.** See [Admission](#admission-for-unauthenticated-routes). Each route does
  constant work, and storage stays bounded.

### Failure, restart, concurrency

- Pending authorizations are durable rows, so a restart does not lose them, and the
  page's poll continues afterwards.
- Codes and refresh tokens are single-use under one SQLite transaction. Two exchanges of
  one code race, and the second loses and revokes. Two refreshes of one token race, and
  the second loses and revokes the grant; nothing about a rotation is kept in memory, so
  a restart changes nothing.
- With `enableMcpServer` off, the authorize page says the MCP server is off, the token
  endpoint refuses `authorization_code`, refresh still works, and `/mcp` answers
  `McpServerDisabledError`. Sessions are kept.
- An agent whose refresh token was revoked or expired gets `invalid_grant`. Codex then
  says "Run `codex mcp login bibcode`", and Claude Code shows **Re-authenticate**.

### Persistence: `McpOAuth` migration

The number is assigned in the [migration summary](#persistence-and-migration-summary).

- `mcp_oauth_clients`: `client_id` (primary key), `client_name`, `redirect_uris_json`,
  `source_key`, `created_at`, `approved_at`, `last_used_at`.
- `mcp_oauth_authorizations`: `id` (primary key), `user_code` (unique), `client_id`,
  `redirect_uri`, `code_challenge`, `state`, `resource`, `scopes`, `origin`, `source_key`,
  `status_cookie_hash`, `status` (`pending`, `approved`, `denied`, `exchanged`),
  `approved_access`, `approved_scopes`, `code_hash`, `code_expires_at`, `session_id`,
  `created_at`, `expires_at`.
- `mcp_oauth_refresh_tokens`: `token_hash` (primary key), `session_id`, `client_id`,
  `issued_at`, `used_at`. Rows go with their session.
- `auth_sessions.mcp_resource TEXT NULL`.

### UI (Agent integrations, MCP tab)

- **Remote agents row.** For an environment with an eligible origin (a managed tunnel, or
  a saved HTTPS endpoint), it shows the MCP URL with **Copy for Claude Code**
  (`claude mcp add --transport http bibcode <url>`) and **Copy for Codex**
  (`codex mcp add bibcode --url <url>`, which starts sign-in itself).
  - Otherwise it says: "Remote agents need an HTTPS address. Use the launch command over
    SSH instead."
- **Requests to connect.** A card for each pending authorization, with:
  - the client name (untrusted text), the redirect host, the request origin, the scopes
    asked for, and the code;
  - an **Agents may** select, defaulting to and capped at the environment's;
  - an **Allow terminals** checkbox, shown only when the client asked for it and slice
    T's conditions hold, unchecked by default;
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
  - AS metadata with an `issuer` equal to the origin, `S256`, both grant types, and
    `authorization_response_iss_parameter_supported`.
  - Both are 404 on a non-loopback `http` origin and on a preview hostname.
- **401 challenge.** An unauthenticated POST and GET both name the PRM URL; it is absent on
  an ineligible origin; an authenticated GET is 405.
- **Register.** It refuses a non-loopback `http` redirect URI; the per-source and global
  limits hold.
- **Authorize.**
  - An unknown client or redirect URI shows an error page with no redirect.
  - A loopback redirect URI with a different port from the registered one is accepted;
    an HTTPS one with any difference is refused.
  - A missing or `plain` PKCE method is refused.
  - A `resource` for another origin is refused.
  - An empty scope request is the default pair; `offline_access` is ignored.
- **Flow.** Approve, then status redirects with `code`, `state` and `iss`, then token
  with the right verifier returns an access token with `expires_in: 3600` and a refresh
  token.
  - A wrong verifier, a reused code (which also revokes the session), or an expired code
    is refused.
- **Refresh.**
  - A refresh returns a new pair, and the old refresh token then fails.
  - The old token used again, at once or later, gets `invalid_grant` and revokes the
    grant, so the new access and refresh tokens fail too; two concurrent refreshes of one
    token leave one success, then a revoked grant.
  - A remote OAuth call's `files_download` URL uses the session's origin (X5's base).
  - A refresh asking for `terminal:operate` that was not granted is refused.
  - An access token past `exp` gets 401 at `/mcp`, and a refresh restores access.
  - Revoking the client makes the next refresh `invalid_grant`.
- **Token exchange unchanged.** The RFC 8693 exchange still works on a plain-HTTP
  non-loopback origin, where `authorization_code` is refused.
- **Forwarded headers.**
  - A tunnel-shaped request (loopback peer, `Host` the managed hostname,
    `X-Forwarded-Host: 127.0.0.1`) keeps its `Host`.
  - An nginx-shaped request (loopback peer, `Host: 127.0.0.1:3773`, both forwarded
    headers) gets the forwarded host and scheme, as today.
- **Audience.**
  - An OAuth token works at its origin's `/mcp` and gets 401 at another `Host`.
  - A relay token and a provider token each get 401 through the tunnel and through a
    proxy, and work on a direct request.
- **Admission.** A flood of authorizations from one source leaves room for a request
  from another source; a flood from one client leaves room for another client.
- **Approval route.**
  - It needs `access:write`; a standard pairing bearer is refused.
  - `access` above `mcpServerAccess` is refused.
  - `terminals` is refused when the client did not ask for it, or the setting is off.
- **CLI.** `bibcode mcp authorize` lists and approves through the data root.
- **Off switch.** The authorization-code grant is refused, refresh works, and the page
  explains why.
- **Inventory.** `ROUTE_INVENTORY` lists the new routes with their auth class, and the
  audience test still refuses an `mcp-client` token on every authenticated route.
- **Live smoke.** `claude mcp add --transport http` and `codex mcp add --url` each
  complete the flow through an HTTPS reverse proxy and through BiBCode Connect, and keep
  working across a refresh (an access lifetime shortened for the test).

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
- **Shared files.** The CLI (branch `claude/v0131-139-cli`) edits `lib.rs`, `config.rs`,
  `lifecycle.rs`, `mcp/control.rs`, `mcp/relay.rs` and `diagnostics/profiler/cli.rs`, and
  adds no migration. It lands on the batch branch before F0 starts and before R starts,
  so F0 moves its `control.rs` changes with the code, and R adds `mcp authorize` beside
  its `thread` dispatch.
- **Its sessions** are relay-style (`mcp_resource` NULL) on a direct loopback request, so
  R's audience rule accepts them unchanged.
- **Attachments.** The CLI's `start` and `send` could take attachments after slice A;
  this is not planned here.

## Persistence and migration summary

| Migration                | Slice | Change                                                                                                                                      |
| ------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 59 `McpToolOutcomes`     | F0    | `mcp_tool_requests.state` (default `commands`; also `running`, `done`, `failed`, `unknown`), `mcp_tool_requests.outcome_json`               |
| 60 `McpActorAttribution` | X1    | `projection_thread_messages.actor_json`, `projection_thread_messages.source_thread_id`, `projection_threads.requester_json`, `mcp_activity` |
| 61 `Webhooks`            | X8    | `webhook_endpoints`, `webhook_deliveries`, `webhook_state`                                                                                  |
| 62 `McpOAuth`            | R     | `mcp_oauth_clients`, `mcp_oauth_authorizations`, `mcp_oauth_refresh_tokens`, `auth_sessions.mcp_resource`, with `CORE_TABLES` rows          |

Each migration has one owner, and the waves land them in number order (58 is the last one
used, by slice 1). If another branch lands a migration first, the remaining ones renumber
in order at landing; nothing depends on the numbers. X7's suggestion and X4's intents are
in memory and need none.

**Contracts:**

- `settings.ts`: `mcpCapabilities` (F0); `enableWebhooks` (X8);
- `orchestration.ts`: `OrchestrationEventMetadata.actor`, `thread.create.purpose`, the
  turn message's `sourceThreadId`, and the projected actor and requester (all X1, optional);
- `gitManager.ts`: the `remote-branch-delete` operation (G);
- `project.ts`: `deleteEntry.toTrash`, optional (X5);
- `auth.ts`: `AuthAccessStreamEvent.pendingMcpAuthorizations`, optional (R);
- new: the activity stream (X1), the UI intent stream (X4, X7), and the webhook methods
  (X8).

**New RPC methods**, each registered through the `rpc/session.rs` wrappers:
`subscribeMcpActivity` (X1); `ui.publishIntent` and `subscribeUiIntents` (X4);
`webhooks.*` (X8). **New HTTP routes:** `/api/auth/clients/mcp-access` (X1) and the OAuth
routes (R).

## Profiler, crash, and trace coverage

| Item                  | Coverage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Child processes       | None new. Git runs through the repository layer, terminals through the terminal runtime, and devices through `DeviceManager`, each already supervised and attributed.                                                                                                                                                                                                                                                                                                                                                                                    |
| RPC methods           | B1 and `invoke_local_stream` keep the registry's admission. X2's profiler tools read in process and take no RPC admission; they are still timed as `mcp.<tool>`. Every tool is timed as `mcp.<tool>`, and `is_long_running` derives from `ToolSpec` (network tools are `long_running: true`). The F0 test iterates every family. New methods (X1, X4, X8) register through the `rpc/session.rs` wrappers; `webhooks.sendTest` and `webhooks.redeliver` join `is_long_running`. The new HTTP routes are not RPC; they log failures with `tracing::warn!`. |
| Worktree removal      | Both modes reach the handlers that call `record_removal_outcome`. A test asserts one event per real removal and none per replay. No new removal path.                                                                                                                                                                                                                                                                                                                                                                                                    |
| Binaries and re-exec  | `mcp authorize` is dispatched after `crash::attach()` in both `main.rs` files, under the existing `mcp` branch.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Shutdown              | Owned mutations and terminal-read waits stop at `McpControl::shutdown`, which already runs right after `profiler.begin_stopping()` and before orchestration and profiler teardown. The webhook dispatcher (X8) is a new service and stops in the same place, before the profiler's teardown.                                                                                                                                                                                                                                                             |
| Events, logs, records | One `info` line per destructive call (C7). No prompt, message, commit message, PR body, path, terminal content or webhook URL, and nothing new in fingerprints. Activity rows (X1) and webhook payloads (X8) hold ids and counts only.                                                                                                                                                                                                                                                                                                                   |
| Documentation         | The new `mcp.*` names, and the note that `mcp.<tool>` timing covers them, go in `docs/skills/bibcode-profiler/references/` and the Profiler section of `overview.md` (slice Z).                                                                                                                                                                                                                                                                                                                                                                          |

## UI review (UI.md)

**Changed surfaces:**

- The MCP tab's copy, and the **What agents can use** switches (T).
- The **Agents** list, the activity list, the agent chips, and the header indicator with
  **Stop**, **Take over** and **Hand back** (X1).
- The **From <panel>** provenance and the **wants to show** toast (X4).
- The commit message suggestion in the Source Control panel (X7).
- The **MCP** and **Webhooks** tabs and the section's status line (X8).
- The **Remote agents** row, the **Requests to connect** cards, and the toast (R).
- The server-rendered consent page (R).

Against UI.md:

- **Defaults stay safe.** Terminals and webhooks are off. Remote access needs an explicit
  approval each time, and the terminal checkbox starts unchecked.
- **Who acted is visible.** Agent work carries its label wherever it shows up, and the
  person can stop or pause the agent from any screen.
- **User work is preserved.** `focus_ui` never moves the layout by itself, a commit
  message suggestion never overwrites a draft, and `files_write` refuses a file that
  changed since the agent read it.
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
- **Confirmation only where something is lost.** Every switch is reversible, Approve is
  itself the confirmation, and Stop and Take over only stop an agent. Deleting a webhook
  endpoint asks, because its delivery log goes with it.
- **Errors are actionable.** The consent page and the typed tool errors name the setting
  or the action that fixes them.

The `vercel-react-best-practices` review applies to `AgentIntegrationsSection.tsx`, the
new components, and the changed `MessagesTimeline.tsx`, Source Control panel and stores.
The activity and intent streams feed narrow selectors, so a new row does not re-render
the timeline.

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
- `docs/user/remote-access.md`: the remote agent setup, and the reverse-proxy rule that
  `Host` must stay loopback for the forwarded headers to count;
- `docs/architecture/remote.md` "Security boundaries" (`:1751-1757`): the narrowed
  forwarded-header rule.

**Extended-scope slices** own their living docs:

- X1: `docs/architecture/rpc-and-orchestration.md` (event actor, activity stream);
- X3: the `changes_since` cursor contract in `docs/user/mcp.md`;
- X5: the transfer token's bound `overwrite` in `docs/architecture/remote.md`;
- X8: a new `docs/user/webhooks.md` (payload, signature check, retries, the 5-minute
  timestamp window a receiver should enforce) and its section in `overview.md`.

**Slice Z** (last, one owner):

- **`docs/user/mcp.md` sections.** "What it can and cannot do" inverts (approvals and
  destructive tools), and the safety model from C6 is added.
- **Living docs.** `overview.md` Profiler and MCP sections, and
  `docs/skills/bibcode-profiler/references/`.
- **Slice-1 doc.** A dated "Superseded 2026-10-30" note under its Non-goals and its
  "Approvals?" answer. The decisions themselves are not edited.
- **Runbooks.** `docs/testing/cross-platform-validation.md` and `ssh-environments.md`
  gain smoke steps for a destructive tool, a terminal, the off switch mid-push, Stop and
  Take over, a webhook delivery, and a remote OAuth connect with Claude Code and Codex.
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
     - **"use a terminal"** with terminals off: name the setting;
     - **"what changed while I was away"**: use `changes_since` with the stored cursor,
       not a transcript re-read;
     - **an outcome unknown** after an interruption: check state, then retry with a new
       `clientRequestId`.
  2. Update `evals.json` and `trigger-evals.json`.
  3. Write the minimal skill text.
  4. Re-run, and close the loopholes.
  5. Keep the stubs in `.agents/skills/` and `.claude/skills/` byte-identical.

## Implementation partition

### Constraints

- **Disk.** About 320 GB is free, and each Rust writer needs its own `target/` of 30 to
  55 GB. A `target/` is never shared between live worktrees: a shared one runs another
  worktree's binaries. At most four Rust writers therefore run at once (at most 220 GB),
  which leaves headroom for the build caches and the desktop bundle.
- **Reuse.** A writer in a later wave may take over a finished writer's `target/` (point
  `CARGO_TARGET_DIR` at it, or move it), only after that writer has handed off. A web-only
  writer needs none.
- **Load.** While four writers run, each sets `CARGO_BUILD_JOBS` to about a quarter of the
  cores, runs focused tests during the work, and runs the full server suite once before
  hand-off, with at most two full suites at a time. F0 runs alone with every core.
- **Order.** The `bibcode thread` CLI lands on the batch branch before F0 starts. R lands
  last among the code slices, and Z last of all.

### Waves

```text
CLI (landed) ─ W0: F0 ─ W1: A W G P ─ W2: X1 T D X2 ─ W3: X3 X4 X5 X6 ─ W4: X7 X8 ─ W5: R ─ W6: Z
```

| Wave | Writers (Rust `target/`)       | Depends on                                     | Migration |
| ---- | ------------------------------ | ---------------------------------------------- | --------- |
| W0   | F0 (1)                         | the CLI on the batch branch                    | 59        |
| W1   | A, W, G, P (4)                 | F0                                             | —         |
| W2   | X1, T, D, X2 (4; reuse W1's)   | F0; X1 after A and W (it edits their families) | 60 (X1)   |
| W3   | X3, X4, X5, X6 (4; reuse W2's) | X1 (activity rows, actor, `source_thread_id`)  | —         |
| W4   | X7, X8 (2; reuse W3's)         | X4 (intent stream), X3 (cursor), X1            | 61 (X8)   |
| W5   | R (1; reuses one)              | F0, the CLI, X8 (the section's tabs)           | 62 (R)    |
| W6   | Z (docs only)                  | everything                                     | —         |

Within a wave the writers share only one-line registrations (`FAMILIES`,
`mcp/tools/mod.rs`, `mcp_tools_tests/mod.rs`), whose conflicts are trivial. Every other
shared file has one owner per wave, listed below.

### File ownership

| Slice | Owns (new or changed)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F0    | `mcp/control.rs`, `mcp/mod.rs`, `mcp/wait.rs`, new `mcp/tools/mod.rs`, new `mcp/tools/threads.rs` (move, plus the `interrupt_turn` fix), new `mcp/target.rs`, new `mcp/outcome.rs` (recorded outcomes and live controls), new `mcp/tools/previews.rs` (provider dispatch extracted), `mcp/relay.rs` (terminal scope at mint), `rpc/session.rs`, `persistence/migrations.rs` (59), `persistence/repositories.rs` (outcome rows), `production/connect_mcp.rs` (extraction, kind-aware call), `production/connect_mcp/tests.rs`, `production/control.rs` (`mcpCapabilities`), `production/mcp_tools_tests.rs` → `mcp_tools_tests/{mod,threads}.rs`, `diagnostics/profiler/latency.rs`, `auth/service.rs` (`issue_mcp_pairing_link` extra scope only), `packages/contracts/src/settings.ts` and fixtures                                |
| A     | `mcp/tools/threads.rs`, new `mcp_tools_tests/thread_actions.rs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| W     | new `mcp/tools/worktrees.rs`, new `mcp_tools_tests/worktrees.rs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| G     | new `mcp/tools/git.rs`, `git/repository.rs` (literal pathspecs), `git/manager/operations.rs` (discard containment, `remote-branch-delete`), `production/git_vcs.rs` (literal pathspecs on the `vcs.*` file paths), `packages/contracts/src/gitManager.ts` (and any exhaustive web `switch` over operation kinds), new `mcp_tools_tests/git.rs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| P     | new `mcp/tools/pull_requests.rs`, new `mcp_tools_tests/pull_requests.rs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| X1    | `orchestration/engine.rs` (actor in planning), its projector, `production/orchestration_rpc.rs`, `production/worktree_catalog_rpc.rs` (actor pass-through), `persistence/migrations.rs` (60), `persistence/repositories.rs` (projection columns, activity rows), new `mcp/activity.rs`, `mcp/control.rs` (one activity hook), `mcp/tools/threads.rs` and `worktrees.rs` (`purpose`), `auth/http.rs` and `auth/service.rs` (`mcp-access` route), `rpc/methods.rs` and `auth/scope.rs` (one stream), `packages/contracts/src/orchestration.ts` and a new activity contract, the client-runtime stream, `MessagesTimeline.tsx`, the thread list chip, the header indicator, the Source Control commit-row chip, new `McpAgentsPanel.tsx`                                                                                               |
| T     | new `mcp/tools/terminals.rs`, `terminal/history.rs`, `terminal/manager.rs`, new `mcp_tools_tests/terminals.rs`, `AgentIntegrationsSection.tsx` and its test (capability switches and MCP-tab copy; owner in W2; X1 adds one mount line after it)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| D     | `mcp/tools/previews.rs` (client twins), `production/connect_mcp/device_tools.rs` only for a `pub(crate)` accessor, new `mcp_tools_tests/previews.rs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| X2    | new `mcp/tools/diagnostics.rs` (tools and projections), `diagnostics/profiler/mcp.rs` (handlers `pub(crate)`), new `mcp_tools_tests/diagnostics.rs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| X3    | new `mcp/tools/feed.rs`, `persistence/repositories.rs` (the transition read; owner in W3), new `mcp_tools_tests/feed.rs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| X4    | new `mcp/tools/panels.rs`, new `production/ui_intents_rpc.rs`, `rpc/methods.rs` and `auth/scope.rs` (owner in W3), a new intents contract, the web intent toast, the provenance label in `MessagesTimeline.tsx`, new `mcp_tools_tests/panels.rs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| X5    | new `mcp/tools/files.rs`, `workspace/rpc.rs` and `workspace/service.rs` (`toTrash`), `transfer/mod.rs` (session claim), `transfer/upload.rs` (cancellation before the rename), `production/transfer_routes.rs` (bound `overwrite`, live access check, activity rows), `production/runtime.rs` (handler wiring), `mcp/outcome.rs` (a live-token accessor only), `packages/contracts/src/project.ts`, new `mcp_tools_tests/files.rs`                                                                                                                                                                                                                                                                                                                                                                                                  |
| X6    | new `mcp/tools/clone.rs`, new `git/clone_policy.rs`, `git/repository.rs` (policy arguments in `ReservedClone::transfer`), `production/clone_operations.rs` (the policy on `CloneRequest`), `production/git_vcs.rs` (the principal on `vcs.clone` and `sourceControl.cloneRepository`), new `mcp_tools_tests/clone.rs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| X7    | `mcp/tools/git.rs` (reads, commit message tools), `production/ui_intents_rpc.rs` (the `commitMessage` kind), the Source Control panel and `sourceControlPanelStore.ts`, new `mcp_tools_tests/git_reads.rs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| X8    | new `webhooks/` module (store, dispatcher, delivery, signing), `persistence/migrations.rs` (61) and `repositories.rs`, `rpc/methods.rs`, `auth/scope.rs`, `diagnostics/profiler/latency.rs` (owner in W4), the runtime's quiesce sequence, `packages/contracts/src/settings.ts` (`enableWebhooks`) and a new webhooks contract, `AgentIntegrationsSection.tsx` (tabs and status line; owner in W4), new `WebhooksTab.tsx`, `docs/user/webhooks.md`                                                                                                                                                                                                                                                                                                                                                                                  |
| R     | `http.rs` (forwarded-header rule), `auth/http.rs`, `auth/service.rs` (authorization-code and refresh grants, audience), new `auth/oauth.rs`, new `auth/consent_page.rs`, `production/http_routes.rs` (routes, `ROUTE_INVENTORY`), `production/connect_mcp.rs` (401 challenge, audience), `production/connect_mcp/tests.rs`, `persistence/migrations.rs` (62), `persistence/repositories.rs` (OAuth rows), `lib.rs` and `config.rs` (`mcp authorize`), `apps/desktop/src-tauri/src/main.rs` (only if dispatch needs it), `packages/contracts/src/auth.ts`, new `McpRemoteAgentsPanel.tsx` and its test, the toast hook, one mount line in `AgentIntegrationsSection.tsx`, one line in `mcp/tools/files.rs` (the remote transfer base), `docs/architecture/remote.md`, `docs/cloud/environment-auth.md`, `docs/user/remote-access.md` |
| Z     | new `docs/reference/mcp.md` and `docs/reference/webhooks.md` (the agent-facing references, see Revision 4), a drift test that every registered tool and webhook event appears in them, `docs/README.md` (links), `docs/user/mcp.md` (cross-cutting sections), `docs/architecture/overview.md`, `docs/skills/bibcode-profiler/references/*`, `docs/skills/bibcode-mcp/**`, the `.agents/skills/` and `.claude/skills/` stubs, `docs/testing/*`, `docs/plans/2026-10-24-mcp-operate-server-design.md` (superseded note)                                                                                                                                                                                                                                                                                                               |

### Shared files and their owners, in order

- **`mcp/control.rs` `FAMILIES`, `mcp/tools/mod.rs`, `mcp_tools_tests/mod.rs`:** F0, then
  one line per family.
- **`mcp/tools/threads.rs`:** F0 (move), A, then X1 (`purpose`).
- **`mcp/tools/git.rs`:** G, then X7.
- **`persistence/migrations.rs`:** F0 (59), X1 (60), X8 (61), R (62).
- **`persistence/repositories.rs`:** F0, X1, X3, X8, R, one per wave.
- **`rpc/methods.rs`, `auth/scope.rs`:** X1 (W2), X4 (W3), X8 (W4).
- **`diagnostics/profiler/latency.rs`:** F0, then X8.
- **`auth/http.rs`, `auth/service.rs`:** F0 (issuer only), X1 (`mcp-access`), R.
- **`production/connect_mcp.rs`:** F0, then R.
- **`mcp/tools/files.rs`:** X5, then R's one line for the remote transfer base.
- **`mcp/outcome.rs`:** F0, then X5's live-token accessor (W3).
- **`production/runtime.rs`:** X5's transfer handler wiring (W3), then X8's quiesce step
  (W4) if it lands there.
- **`git/repository.rs`, `production/git_vcs.rs`:** G (W1), then X6 (W3).
- **`production/ui_intents_rpc.rs`:** X4, then X7.
- **`AgentIntegrationsSection.tsx`:** T (W2, X1's mount line after it), X8 (W4), R's
  mount line (W5).
- **`MessagesTimeline.tsx`:** X1, then X4.
- **Contracts:** `settings.ts` F0 then X8; `orchestration.ts` X1; `gitManager.ts` G;
  `project.ts` X5; `auth.ts` R.
- **`docs/user/mcp.md`:** each slice its own subsection; Z the cross-cutting sections,
  last.
- **The scope set:** no new scope constant, so `auth/model.rs` is untouched.

## Verification

Per slice:

- the focused tests above, written to fail first;
- `cargo fmt --all --check`;
- Clippy with `-D warnings` on the server, and on the desktop for R;
- the server test suite;
- `vp check` and `vp run typecheck`.

UI slices (T, X1, X4, X7, X8, R) add the web tests, the UI.md review and the
`vercel-react-best-practices` review.

Manual smoke tests:

- Claude Code over stdio running the full flow: create a worktree, start, wait, stage,
  commit, push, create the PR, merge, remove the worktree. A second BiBCode client shows
  each step with the agent's label.
- Codex with its default timeouts, including a push.
- `ssh <host> bibcode mcp` with terminals on.
- Remote OAuth with Claude Code and with Codex, through an HTTPS reverse proxy and through
  BiBCode Connect, across an access-token refresh.
- Revoking mid-session, **Stop** and **Take over** mid-push, and the off switch mid-push.
- A webhook receiver that drops deliveries, catching up through `changes_since`.

## Risks

- **Destructive defaults** (C6). This is the main risk, and it is accepted by the user's
  decision (Question 1).
- **Attribution lands in the second wave.** Until X1 ships, agent actions look like a
  person's; the activity log, chips and Stop follow it.
- **Outcome unknown** after a crash or an interruption (C4) makes the agent check state by
  hand. This is rare, and it is never a false success.
- **The narrowed forwarded-header rule** (R) changes every route: a proxy that sends the
  public `Host` and relies on `X-Forwarded-Proto` loses the scheme. The documented nginx
  recipe is unaffected; the runbook and `remote.md` say so.
- **Tunnel source keys** (R). Through the managed tunnel, a flood can delay tunnel
  authorizations; it cannot grant access or block other paths.
- **Strict refresh reuse** (R). Any second use of a refresh token revokes the grant. A
  harness that refreshes one token twice, or loses a refresh response, must sign in
  again. Codex serializes its refreshes; Claude Code's behavior with two processes is
  unverified.
- **The upload lifetime** shorter than the retry window (slice A). This is a typed error,
  not a lost attachment.
- **Cached tool lists.** As slice 1 notes, a harness that cached its list keeps showing
  tools after a capability turns off; their calls still fail typed.
- **The HTTPS requirement** leaves plain-HTTP LAN environments on SSH only. This is
  documented.
- **Webhook secrets** sit in plaintext 0600 files, as the host identity secret does.
- **Transfer URLs** in an agent's context (X5) are capabilities for 5 minutes.

## Could not verify

- **Tasks client support.** The client matrix page came back with empty cells. Claude
  Code's beta support comes from its own docs.
- **The edge's handling of client `X-Forwarded-*` headers** through the managed tunnel.
  R no longer depends on it.
- **Tailscale Serve's headers.** R treats it as eligible only if it presents as the nginx
  recipe does.
- **Codex's `modern_session` tool path** sending a `progressToken`; the default path does
  (`rmcp/src/service.rs:887-899`).
- **Upload lifetime.** The staging service expires an idle upload after 600 seconds
  (`transfer/staging.rs:44-60`); whether a staged but unconsumed attachment outlives that
  needs a test in slice A.
- **Checkpoint revert during a turn.** The exact error tag when `thread.checkpoint.revert`
  runs while a turn is running.
- **The 2025-06-18 revision.** `protocol.rs` also serves it (`VERSIONS`), but only the
  2026-07-28 and 2025-11-25 authorization pages were read.
- **`DELETE` headers.** Whether any harness sends `MCP-Protocol-Version` on `DELETE`.
- **Claude Code and `destructiveHint`.** Whether it prompts differently for
  `destructiveHint` tools (its docs describe only the retry and parallel behaviors of the
  other hints). C2 does not depend on it.
- **The relay's mapping of a refused credential** to a typed tool result (X3 checks it).
- **Claude Code refreshing one token from two processes** (R). Its docs do not say
  whether it serializes refreshes as Codex does. If it does not, strict reuse shows a
  **Re-authenticate** prompt; it never grants access.
- **The input shapes of `gitManager.getDiff`, `getCommits`, `getRefs` and `getStashes`**
  (X7).

Settled since the first draft: Codex's DCR, CIMD, `resource`, refresh, `iss`, step-up and
`mcp add --url` behavior, and its progress tokens (from its source); whether the tunnel
delivers the public `Host` (from the relay's ingress and the preview gateway); and Claude
Code's refresh, step-up and redirect behavior (from its docs).

## Questions for approval

Questions 1 to 7 of the first draft are answered (see [Revision 2](#revision-2-2026-10-30)).
Question 8 is answered too (see [Revision 3](#revision-3-2026-10-30)), so none remains:

8. **Where may an agent clone?** Resolved 2026-10-30: only next to a registered project
   (`parentProjectId`), with no new allow-list setting of clone roots.

## F0 implementation notes (2026-10-30)

F0 was implemented on `claude/v0131-139-f0`, from `claude/issue-batch-after-v0.13.0` at
`2c791ec593` (slice 1, the `bibcode thread` CLI and this design). Nothing below changes a
settled decision; it records drift, the APIs later slices plug into, and choices the design
left open.

**Drift found:**

- **The log test pins its own path.** `the_log_never_sees_a_prompt_or_a_reply` runs in its
  own process by test path; after the move it is
  `production::mcp_tools_tests::threads::the_log_never_sees_a_prompt_or_a_reply`.
- **Migration tests enumerate ids.** `exposes_all_ordered_migration_metadata`, the
  legacy-ledger tests and the applied-range assertions list every id up to 58; each now
  includes 59. Migration 59 adds columns only, so `CORE_TABLES` is unchanged.
- **Struct literals.** Every `McpServerSettings { enabled, access }` in the tests gained
  `..McpServerSettings::default()`; `Default` stays "on, Supervised", which the relay's
  missing-settings path relies on.
- **Three failure shapes, not two.** Besides `failed` and `action_failed`, both stream
  handlers send an `Err(Value)` chunk (workspace unavailable); the collector returns it as
  the typed failure it is.
- **Provider dispatch reaches `DeviceTools::call`.** It was `pub(super)` in
  `connect_mcp/device_tools.rs` (slice D's file); F0 widened only that method to
  `pub(crate)` so `mcp::tools::previews::run` can call it. `device_tools.rs` still imports
  `snapshot_tool_result` and `tool_failure` through `connect_mcp`, which re-exports them
  from `previews.rs`.
- **`SCOPE_TERMINAL_OPERATE`** was not exported from `auth/mod.rs`; F0 exports the existing
  constant for the relay (and slice T's specs). No scope constant is new.
- **Outcome rows stay in `mcp/outcome.rs`.** Slice 1 keeps its `mcp_tool_requests` SQL in
  the tool layer, so the outcome rows do too; `persistence/repositories.rs` is unchanged.

**APIs later slices plug into:**

- **Registering a family.** Add `mcp/tools/<family>.rs` exporting
  `pub(crate) const FAMILY: Family = Family { tools, text, call }`, one `pub(crate) mod` line
  in `mcp/tools/mod.rs`, and one line in `control::FAMILIES`. `text(name)` returns
  `Some((description, input schema))` for each client tool (use `object_schema` and
  `CLIENT_REQUEST_ID`); `call` returns a boxed future that matches the name.
- **Specs.** `ToolSpec::client(name, scope, methods)` is a mutating Workspace tool; chain
  `.reads()` (read-only and idempotent), `.runs_long()`, `.waits()` (wait slot; only for a
  tool that idles on the engine), `.destroys()` (destructive and audited, never
  idempotent), `.audit()` (`git_revert_commit`), `.repeats_safely()` (`git_fetch`,
  `terminal_resize`), `.open_world()` (also long-running), `.in_set(Some(set))`. A
  provider tool is `ToolSpec::provider(name, scope)`. The family test checks unique names
  per kind, scope equals each method's `required_scope`, and destructive implies audited.
- **Targets and paths.** `call.target(thread_id)` returns the thread, its project id and
  `cwd`; `validate_paths(cwd, paths)` applies C5 (literal paths only, at most 200, no
  `..`, NUL, absolute path, glob or magic character, no parent that resolves outside
  `cwd`). A path that is itself a symlink is allowed, because Git tracks the link.
- **Recorded mutations.** `call.recorded(tool, &payload, move |owned| async move { … })`
  runs the work under the live controls, at most once with a `clientRequestId`. Inside,
  `owned.invoke(tag, payload)` and `owned.invoke_stream(tag, payload)` (C3, returns
  `StreamOutcome { terminal, output, dropped_output, ignored }`) carry the credential and
  the live token; `owned.cancellation()` is the token for anything else the work starts.
  Return the finished tool result; a typed failure is stored as `failed`, a stream that
  ended early and any interruption as `unknown`.
- **Receipt-backed tools** (worktrees, approvals, checkpoint revert) keep using
  `call.commands(tool, thread_id, fresh)`. A `commands` row under a recorded tool's key
  (or the reverse) is `idempotency_conflict`.
- **Capabilities.** `McpServerSettings.capabilities` (`McpCapabilities`) is live through
  the settings watch; `McpCapability::{key,label}` name a set. The relay's
  `extra_scopes(settings, access)` decides `terminal:operate` at mint.

**Choices made while implementing:**

- **Unkeyed mutations** run inline under the live controls plus the call's cancellation,
  and take no owned slot: they cannot outlive their call, so the per-call admission
  bounds them. Interrupted, they return `McpOutcomeUnknownError` without a row.
- **A capability turned off mid-call does not interrupt work in flight.** C4 lists only
  the off switch, read-only, revocation and shutdown; the next call is refused.
- **Interrupted work gets 10 s** to notice its token before it is dropped; either way it
  is `unknown`, and the slot and claim are released only after the outcome is written.
- **Stream budget.** `invoke_local_stream` takes a budget; owned work uses 30 minutes, and
  a stream past it is `McpStreamEndedError` (`reason: "budget"`), so `unknown`.
- **A `running` row found while this process holds the key's claim** has no owner, so it
  is rewritten as `unknown` (`reason: "restarted"`) and every retry gets the same answer.
- **The issuer** refuses any extra scope other than `terminal:operate`. The relay asks for
  it when `mcpCapabilities.terminals` is on and the lower of `--access` and
  `mcpServerAccess`, read again at mint, is `full-access`.
- **`interrupt_turn` with a named turn** that is not running also dispatches nothing. Its
  result always carries `turnRunning`. The harness has no live provider session, so the
  running case is proven by the engine's refusal naming `thread.turn.interrupt`.
- **The wait-slot test** uses a test family through `McpControl::call_in`: three
  long-running tools and four waits in flight are admitted, a fifth wait is busy, and a
  fourth long-running call is still admitted. `git_push` and `device_open` client tools
  do not exist yet.
- **The capability test** uses `sourceControl` and `workspace`, because the X5 `files`
  tools do not exist yet.
- **No Settings UI.** `mcpCapabilities` has no switch until slice T; until then
  `McpCapabilityDisabledError` can only follow a hand-edited settings file, and its message
  already names the section where T puts the switches.

**Review fixes (Codex P2, round 2):**

- **An owned mutation takes its own maintenance admission.** C4 said it holds "the
  registry admission permit" until settled, but the permit `invoke_local` takes rides in
  the request context, which unary registrations such as `gitManager.commit` drop before
  their work ends; the `/mcp` request's HTTP permit ends when the client disconnects. A
  keyed call now admits `MCP <tool>` as a mutation before it inserts its `running` row and
  releases it after the outcome write, so update preparation's drain waits for detached
  work. While maintenance holds admission closed, a keyed call is refused with
  `UpdateMaintenanceActiveError` and records nothing, so its key stays usable.
  `invoke_local` also holds its permit until the handler returns, as the WebSocket path
  and `invoke_local_stream` do. No helper signature changed.
- **An outcome that cannot be written is `unknown`, never the work's result.** The task
  answers the caller `McpOutcomeUnknownError` (`reason: "unrecorded"`) and tries to record
  that answer; only then does it release the admission, slot and claim. If that write
  fails too, the row stays `running` and every retry answers `unknown`
  (`reason: "restarted"`); rewriting an unowned `running` row no longer turns a storage
  error into `McpStorageError`, since the answer is `unknown` either way.

## A (thread actions: approvals, checkpoint revert, attachments) implementation notes

Slice A was implemented on `claude/v0131-139-a`, from `claude/v0131-139-f0`. The tools stay
in the threads family (`mcp/tools/threads.rs`); its tests are
`production/mcp_tools_tests/thread_actions.rs`. Nothing below changes a settled decision.

**Delivered:**

- `answer_approval` (`thread.approval.respond`, `.destroys()`). A question's id, or an
  approval's id given to `answer_question`, is `McpRequestKindError`, naming the right tool;
  an id that is not pending is `McpInvalidArgumentError`. `accept` and `acceptForSession`
  meet the ceiling and pass the thread to `commands()`; `decline` and `cancel` pass `None`.
- `list_pending_requests` returns each approval with `answerWith: "answer_approval"`, its
  `kind`, its summary and `decisions` (the contract's four; the UI offers all four for
  every kind).
- `revert_thread_to_turn` (`thread.checkpoint.revert`, `.destroys().runs_long()`).
- `attachments` on `start_thread` and `send_message`, staged through `uploads.begin` and
  `uploads.append`, which both tools now list among their methods.

**Drift and verified facts:**

- **Revert while a turn runs has no RPC error tag.** The engine accepts
  `thread.checkpoint.revert` whatever the session does; the effects worker refuses later
  and appends a `checkpoint.revert.failed` activity ("Interrupt the current turn before
  reverting checkpoints."). The tool therefore refuses a running turn itself, before any
  command (`McpTurnRunningError`, the UI's own guard), and refuses a `turnCount` past the
  latest checkpoint (`McpInvalidArgumentError`).
- **A revert's outcome is asynchronous**, so "the result names the turn reverted to" needs
  a wait. The tool subscribes to engine events before dispatching, then reads
  `orchestration_events` after its dispatch's sequence for `thread.reverted`, a
  `checkpoint.revert.files-only` activity (`conversationRewound: false`) or a
  `checkpoint.revert.failed` activity (`McpCheckpointRevertError` with the worker's
  detail), waking on the thread's events, for at most 30 s. Reading the log, not the live
  stream, also answers a receipt replay. Past 30 s, cancellation or shutdown it returns
  `reverted: null` and says the revert is still running.
- **Upload lifetime.** A staged upload lives in memory for 600 s idle
  (`UploadLimits::idle`) and is lost on restart. Turn admission binds and retires it, and
  a replay of an admitted turn never binds again (the receipt skips attachment
  preparation), so expiry matters only for a stored request never admitted. That dispatch
  fails with `UploadError` `not_found`, which the tool returns as
  `McpAttachmentExpiredError` ("send it again without clientRequestId"). Quota and other
  upload refusals come back as the service's typed `UploadError` with its `reason`.
- **The 3 MiB cap is not quite reachable.** 3 MiB decoded is exactly 4,194,304 base64
  characters, and both the `/mcp` body (`MAX_MCP_BODY_BYTES`) and the stdio relay's line
  (`protocol::MAX_LINE_BYTES`) are 4 MiB including the JSON-RPC envelope. A call within a few
  KiB of 3 MiB is therefore refused by the transport first, as a JSON-RPC parse error (relay)
  or a 413 (`/mcp`), not as a typed tool failure. The tool's own check stays at the design's
  3 MiB; slice Z's docs should say "a little under 3 MiB".
- **Images.** PNG, JPEG, GIF and WebP go as `image`; any other `image/*` is refused (the
  contract forbids it as a `file`); everything else is a `file`.
- **An accepted answer can still return a provider error.** The engine records the answer
  (the projection resolves the approval) before routing it to the provider; with no live
  session the routing error comes back, as it does for the UI and `answer_question`. A
  retry with the same `clientRequestId` replays the receipt and succeeds without a second
  answer.
- **Shared files touched beyond the one-line registration.** The test harness
  (`mcp_tools_tests/mod.rs`) now builds one `UploadRegistry` and registers `uploads.*` on
  it beside the orchestration RPC, as production does, so staged ids reach turn admission.
  The slice-1 test file (`mcp_tools_tests/threads.rs`) changed three assertions and one
  test name for `McpRequestKindError` and `answerWith`.
- **Docs.** `docs/user/mcp.md` gained the tool rows; its first sentence and the
  "Approvals" bullet were false after this slice and now say an agent may answer. Slice Z
  still owns the rest of "What it can and cannot do": its "Not available" list still names
  "revert", and the `bibcode-mcp` skill's eval 2 still expects a refusal.

**Choices made while implementing:**

- Attachments are decoded and checked (count, 3 MiB decoded in all, by base64 length
  first, shape, type) before anything is staged. A staging failure cancels the uploads the
  call began.
- The faked provider has no live session, so the approval tests assert what BiBCode
  records (the projection's status and decision, and one answer event per retry), not a
  provider resuming. The revert test runs `OrchestrationEffects` over a real Git checkout
  with checkpoints, so the files are really restored.

**Codex review fixes (`claude/v0131-139-a-r2`):**

- **Each revert reads its own outcome.** The effects worker's revert outcomes
  (`thread.reverted`, and the `checkpoint.revert.files-only` and `checkpoint.revert.failed`
  activities) now have command ids of the form `server:{tag}:{request command id}:{uuid}`,
  and `revert_thread_to_turn` reads only the outcomes whose command id contains
  `:{its commandId}:`. Before, a revert asked while another revert of the thread was still
  running returned the earlier one's result. A fresh UUID stays in the id because a
  deterministic one would collide with its own receipt (a different `createdAt`, so a
  digest conflict) when the worker re-runs a request after a crash. Changing the
  `ThreadRevertComplete` payload or event correlation was rejected: both are engine-owned.
- **A revert whose files were not restored fails.** Once the provider has rewound, the
  worker records the revert even when restoring the files fails, then appends
  `checkpoint.revert.failed`. That completion now uses its own tag,
  `checkpoint-revert-unrestored` (`UNRESTORED_REVERT_TAG`), so the tool ranks it after any
  final outcome and keeps waiting for the failure, returning `McpCheckpointRevertError`
  with the worker's detail ("The conversation was rewound, but the files could not be
  restored: …"), or a generic message of the same meaning if the wait ends first. The UI's
  work log is unchanged.
- **Uploads no admitted turn owns are released.** `start_thread` and `send_message` record
  the upload ids their `fresh` step staged and, after `commands()`, cancel those the
  returned commands do not name (the call failed after staging, or another call with the
  same `clientRequestId` stored its commands first). A turn start whose dispatch fails and
  that the engine did not admit (no receipt, or a `rejected` one) cancels its uploads, so a
  refused call no longer holds the 16-upload session quota for 600 s. The trade-off: a
  retry with the same `clientRequestId` after such a failure gets
  `McpAttachmentExpiredError` ("send it again without clientRequestId") instead of the
  original refusal. A receipt still `reserved` or `prepared` keeps its uploads.
- **Files touched beyond slice A's:** `production/orchestration_effects.rs`, for the
  outcome command ids (`outcome_id`, `RevertPlan::request`, `UNRESTORED_REVERT_TAG`). No
  event type, payload or activity kind changed.

## W (worktree tools) implementation notes (2026-10-30)

W was implemented on `claude/v0131-139-w`, from `claude/v0131-139-f0`. It adds
`mcp/tools/worktrees.rs` (`list_worktrees`, `create_worktree`, `get_worktree_removal_plan`,
`remove_worktree`) and `mcp_tools_tests/worktrees.rs`, with one registration line each in
`mcp/tools/mod.rs`, `control::FAMILIES` and `mcp_tools_tests/mod.rs`.

**Drift found:**

- **Three removal modes, not two.** The web picks `cleanup-stale-registration` when a plan's
  availability is `missing-registered` (`WorktreeRemovalDialog.tsx:328`); `delete` then
  answers `stale-plan`, so an agent had no way to clear a worktree whose folder is gone.
  `remove_worktree` takes `mode: cleanup` for it. `delete` and `cleanup` need `planToken`
  and `expectedGeneration`; `detach` (`worktree.removeFromBibCode`, which takes neither)
  ignores them and refuses `discardChanges` or `confirmRepositoryWidePrune`.
- **No `managed` flag or change flags in `list_worktrees`.** The catalog snapshot has
  neither; computing change flags would run Git once per worktree (up to 200 a page). Each
  entry has `hostThreadId` (null when BiBCode tracks no thread for it), and the description
  points to `get_worktree_removal_plan` and `git_status` for change counts.
- **`McpNotAWorktreeError` also covers a non-host thread.** `resolve_removal_thread` accepts
  only the `workspace` thread that owns the path, so a panel thread in a worktree is refused
  with its `hostThreadId` named, not sent on to fail as `thread-not-found`.
- **`currentGeneration` is not kept.** `rpc_failure` keeps `reason` but not the removal
  error's `currentGeneration`; a stale plan asks the agent to read the plan again anyway.

**Choices made while implementing:**

- **Stored rows wrap the payload.** Each stored request is `{ commandId, runtimeMode?,
  method?, payload }`. `check_unaccepted` reads `commandId` and a top-level `runtimeMode`,
  so an unaccepted `create_worktree` replay still meets the current ceiling although
  `worktree.createManaged` nests the mode under `threadDefaults` (`deny_unknown_fields`).
  `remove_worktree` stores the method it chose and accepts only its two methods on replay.
- **Removal resolves the thread only for a new request**, inside `fresh`: a completed
  removal deletes the host thread, and a retry must replay, not fail
  `McpThreadNotFoundError`. It passes `thread_id: None`, so no ceiling applies to removal
  beyond "not read-only" (C6).
- **`list_worktrees` always refreshes** (`reason` omitted, so `explicit`): `focus` can
  return a cached snapshot from before a creation. Pages are offsets (`w:<n>`) over the
  descriptors followed by host threads Git no longer lists.
- **Tests run the real catalog.** The shared harness registers methods before its engine
  exists, so the test registers forwarding handlers that call a registry built on that
  engine afterwards; scope and admission still run on the harness's registry. Each test
  creates its repository in its own temporary folder, so managed worktrees
  (`<parent>/.bibcode-worktrees`) stay inside it. The profiler test runs in its own process
  and counts exactly one `worktree.removal` event across a keyed removal and its replay.
- **Docs.** `docs/user/mcp.md` gains a "Worktrees" subsection and
  `docs/architecture/rpc-and-orchestration.md` a "Worktree tools" subsection. The user doc's
  "Not available" bullet still lists worktree removal; slice Z rewrites that section.

**Codex review fixes (round 2, `claude/v0131-139-w-r2`).** All three findings were confirmed
in source, and each fix has a test that failed first:

- **A cancellation after handoff stopped the removal.** `remove_worktree` passed the call's
  token to `worktree.remove`, and the catalog checks it after preparing the removal and
  before Git runs (`remove_worktree_owned`, after `quiesce`), so the removal answered
  `orchestration-failed` and left the folder. The removal now runs under
  `McpControl::shutdown_token()`. A test quiescer cancels the call's token in that window,
  and the removal still deletes the folder. Shutdown still stops a removal there, as it
  does for the UI. A cancellation before handoff no longer stops the request either; a
  claim wait is the only step there that can block.
- **A truncated plan could confirm an unseen prune.** The smallest fix was chosen over
  paging: when `pruneImpact` does not fit (`fit_list`), the plan reports `pruneImpactCount`
  and its `planToken` gains a `partial-impact:` prefix. `remove_worktree` strips the prefix
  and refuses `confirmRepositoryWidePrune` with `McpPruneImpactTooLongError`. A non-empty
  impact means the target's folder is already gone, and Git cleans such a registration
  alone only when it is the only stale one. Such a worktree is therefore removed in the
  app. The test creates 100 stale worktrees with long paths, so it is `cfg(unix)`.
- **A dropped caller lost the audit line.** The fix stays in `worktrees.rs`, and
  `control.rs` is unchanged. The removal RPC runs in its own `tokio::spawn`ed task and
  answers on a oneshot. If the send fails, the task writes the same `MCP destructive tool`
  line. If the waiting side is dropped after the send, its `Drop` writes it: the guard
  closes the receiver and then calls `try_recv`. Each removal therefore logs exactly once.
  The own-process test aborts the waiting call from the quiescer and finds one line. A
  waited removal then adds exactly one more. `record_removal_outcome` is unchanged: both
  paths still reach the catalog handlers.

**Review round 3 (Codex P2, `claude/v0131-139-r3`).** The `partial-impact:` prefix was an
editable part of the token: an agent that stripped it pruned every unseen registration
(reproduced, 101 of them). The prefix is gone. `get_worktree_removal_plan` now returns an
opaque `planToken`, signed with the shared `signed_token` format under a per-process key
(purpose `mcp-worktree-removal-plan`), that holds the catalog's token and whether the plan
showed its whole `pruneImpact`. A new `remove_worktree` request opens it before anything is
stored. A token the server did not sign is `McpInvalidArgumentError`, and a confirmed prune with
a plan that did not show everything is `McpPruneImpactTooLongError`. A keyed replay sends the
stored catalog token, so it never needs the key. A token from before a restart is refused, and
by then its generation is stale anyway. Reading the plan again at removal was rejected:
`worktree.getRemovalPlan` refreshes the catalog and bumps its generation, so the agent's plan
would always be stale. Keeping a set of truncated tokens was rejected too: it needs a bound,
and an agent could evict entries from it. The test strips the old prefix and forges a token;
both are refused, and nothing is pruned.

## G (git write tools) implementation notes (2026-10-30)

G was implemented on `claude/v0131-139-g`, from `claude/v0131-139-f0`. It registers the
`git` family (`mcp/tools/git.rs`, 14 tools in the Source control set) and its tests
(`production/mcp_tools_tests/git.rs`), and changes the Git boundary for every caller.

**Drift found:**

- **Failure output is not returned.** The design returns the last 16,000 characters of
  output when an operation fails. `StreamCollector::push` (`rpc/session.rs`) returns the
  `failed` event without the lines it collected, and `rpc_failure` (`mcp/control.rs`) keeps
  only `code`, `blocked`, `phase` and `reason`. Both are F0's files, so G returns the typed
  failure with `code` and `blocked` only. The follow-up: attach the collector's bounded
  `output` to the failure, keep it in `rpc_failure`, and mark it untrusted.
- **The handler does not validate names.** "Branch names and remotes are passed to the RPC,
  which already validates them" (C5) is not so: push runs `git push <remote> <refspec>`
  without `--`, and branch create, delete, checkout, fetch and pull pass names unchecked, so
  a remote of `--receive-pack=…` would be read as an option. The tools therefore check
  every name before any RPC: a remote must be one `gitManager.getRefs` lists, a branch name
  must pass `is_branch_name` (`git/manager/operations.rs`, strict `check-ref-format`: no
  leading `-` or `+`, no `:`, whitespace, control or wildcard characters, `..`, `@{`, `//`,
  `.`-led parts or `.lock`), and a revision (`sha`, `startPoint`) may not start with `-` or
  hold whitespace. The new `remote-branch-delete` checks both in the handler. The other
  operations' handler paths are unchanged for the Source Control panel, which sends names
  it read from the repository; hardening them is a follow-up.
- **`branch-checkout` with `strategy: "stash"` is not implemented** by the handler
  (`is_implemented_through_phase_16`). `git_switch_branch` with `carryChanges: "stash"`
  does what the panel does: `stash-push` with untracked files, then a plain checkout. A
  clean folder skips the stash; a checkout that fails after a stash returns its failure with
  `stashed: true`.

**Choices made while implementing:**

- **Literal pathspecs** (`--literal-pathspecs` as the first argument) cover `stage_files`,
  `unstage_files` (both forms), `discard_files` (listing, restore and clean),
  `git_manager_tracked_paths` and `git_manager_restore_tracked_paths`. Not covered:
  `git_manager_stash_push`'s paths (only the panel sends them; no stash tool exists) and
  `undo_head_commit`'s restore of deleted paths, whose names come from Git itself (a file
  named with a glob character there is a pre-existing quirk). `validate_pathspecs` is
  unchanged, so every path the panel sends still passes.
- **Discard containment** runs first in `discard_paths`: the deepest existing folder of
  each path is canonicalized, and one outside the canonical `cwd` refuses the whole call
  before anything is trashed or restored. It returns `DiscardError::Git`, so
  `production/git_manager_rpc.rs` needed no change.
- **Methods.** Each spec lists only its mutating method. The reads a tool also makes
  (`gitManager.getRefs`, `vcs.refreshStatus`) need `orchestration:read`, and the family test
  pins `scope == required_scope(method)`.
- **Hints.** As the table says, plus `git_delete_branch` is `open_world` (and so
  long-running): hints are per tool, and with `deleteRemote` it reaches the remote.
  `git_stage` and `git_unstage` carry no `idempotentHint`; only `git_fetch` does.
- **Keys.** Every tool runs through `call.recorded`. `git_stage`, `git_unstage`,
  `git_fetch`, `git_create_branch` and `git_switch_branch` take no `clientRequestId`, as
  the table lists, and run inline under the live controls.
- **Resolution inside the work.** The current branch, its upstream, the remote and the kind
  of push are resolved inside the recorded work, so a keyed retry returns the stored outcome
  even after the branch or upstream changed. The stored payload of those tools is the
  arguments with `cwd`, not one RPC payload.
- **Push defaults.** The branch is the current one; the remote is the named one, else the
  upstream's, else `origin`, else the only remote. A branch without an upstream is
  `publish-branch`. Pushed to its upstream's remote, a branch updates its upstream branch
  whatever its name there.
- **The partial outcome** is `McpPartialOutcomeError` with `local: "deleted"`,
  `remote: "failed"`, `remoteName`, `remoteBranch`, `reason` (the handler's `code`) and
  `recovery: { tool: "git_delete_remote_branch", arguments: { remote, branch } }`. It is
  stored as `failed`, so a keyed retry replays it. If the remote step's stream ended before
  its result, the call is `unknown` instead, since the remote may have deleted it.
  `deleteRemote` without an upstream refuses with `code: "no-upstream"` before anything is
  deleted.
- **The status summary** duplicates `git_status`'s mapping (slice A owns `threads.rs` in
  this wave). It is read after the outcome, also on a replay, so it is current, and it is
  `null` when it cannot be read: a status read never fails work that ran.
- **Tests** run the real `vcs.*` and `gitManager.*` handlers on a temporary repository whose
  `origin` is a bare repository, through `Harness::with_methods`. The Git handlers resolve a
  folder's project from a store of their own, holding project `p1` at the repository. The
  trash is faked. A slow `pre-receive` hook proves a cancelled keyed push still lands and the
  off switch mid-push records `unknown`; `receive.denyDeletes` makes the remote refuse a
  deletion. The agent runs at Supervised, so the destructive tools are proven at the
  default level.
- **Docs.** `docs/user/mcp.md` gains a **Git** subsection. Its "Not available" and
  approvals bullets are slice Z's cross-cutting text and still say these tools do not exist.

**Codex review fixes (2026-10-30, `claude/v0131-139-gp-r2`).** All four findings were
confirmed in source and fixed test-first:

- **Implicit remote as an option.** Git accepts a configured remote such as `--all`, and
  `choose_remote` returned the upstream's, `origin` or the sole remote unchecked, so
  `git_fetch` ran `git fetch --prune … --all` (reproduced). Every remote it picks now passes
  the named remote's shape check. At the Git boundary the `runOperation` handler refuses,
  for every caller, a fetch, pull, push, publish, force-push or remote-branch-delete whose
  remote or branch starts with `-` (`invalid-request`). `--` was not used: `git pull` hands
  its remote to `git fetch` without one, and push's options follow its operands.
- **Discard containment race.** The trash takes a path (osascript, gio and PowerShell
  resolve it), so an `openat`-style handle cannot be bound. The containment check now runs
  again right before each move, and the move gets the checked folder's canonical path (on
  Windows without the `\\?\` prefix the Recycle Bin refuses). A path whose folder now
  resolves outside the checkout is kept and listed in `trashUnavailable`, also under
  `permanent`. The window left is the native command resolving the canonical path.
- **Branch delete when the remote step stops reporting.** It is now
  `McpPartialOutcomeError` with `local: "deleted"`, `remote: "unknown"`, `remoteName`,
  `remoteBranch` and `recovery`, recorded `unknown` through `outcome_unknown`, so a keyed
  retry replays the target the deleted branch can no longer give. The message says to run
  `git_fetch` before finishing. Turning MCP off mid-delete gives the same partial: a work's
  own unknown failure returned within the grace period is kept over the bare
  `McpOutcomeUnknownError`.
- **Permanent discard of an ignored file.** The fallback (`git clean -fd` without `-x`,
  after a status that excludes ignored files) leaves it. After the fallback, an untracked
  path that still exists moves from `permanentlyDiscarded` to `trashUnavailable`; a tracked
  path exists again because it was restored. The Source Control panel only reads
  `trashUnavailable` after a trash request, so its behavior is unchanged.
- **Not changed:** G's `place()` still resolves the thread before `recorded`, so a keyed G
  retry after the thread is deleted answers `McpThreadNotFoundError`. Codex raised this for
  P only; moving it needs `finish`'s status read to handle a missing folder.

**Review round 3 (Codex P2, `claude/v0131-139-r3`).** Two findings for G, both confirmed in
source and fixed test-first:

- **Keyed retry after thread deletion** (the item above). `place()` is gone: each tool checks
  its arguments, and its recorded work resolves the folder (`Owned::target`, through `folder`),
  as P does. The stored payload is the arguments with `threadId`, never `cwd`. `git_discard`
  and `git_stage`/`git_unstage` check their paths inside the work too, since that needs the
  folder. `finish` reads the status from the thread's current folder, and gives `status: null`
  when the thread is gone. A keyed retry of `git_commit` and of a partial `git_delete_branch`
  now returns the stored outcome, recovery target included. A new call on the deleted thread
  is still `McpThreadNotFoundError`, now recorded `failed` under its key, as P's is. The
  reorder changes one more thing: a call with a missing argument on a deleted thread now
  reports the argument, where it used to report the thread.
- **Discard containment still raced the trash.** A folder swapped for an outside symlink after
  the re-check, but before the native trash resolved the path, sent the outside file to the
  trash. A test hook in the move window reproduced it. The window is now closed on unix, and
  the change uses only `libc`, already a unix dependency. `move_to_trash` opens the canonical
  checkout with `O_DIRECTORY|O_NOFOLLOW`, then opens each folder of the path with `openat`
  under the same flags, so a link is never entered. It then `renameat`s the entry by that
  handle into a new `0700` folder `<git_dir>/bibcode-discard/<uuid>/`, created and opened the
  same way, and the trash takes only that staged path. Git never writes there, so a branch
  switch or pull cannot plant a link in it. After the trash, the holder folder is removed.
  When the trash refuses the entry, it is renamed back with `renameat2(RENAME_NOREPLACE)` on
  Linux or `renameatx_np(RENAME_EXCL)` on macOS, never over a file created meanwhile; then it
  stays staged, is logged without its path, and is reported in `trashUnavailable`. Outcomes:
  - a folder that is a link, or not a folder (`ELOOP`, `ENOTDIR`), keeps the entry and lists
    it in `trashUnavailable`, also under `permanent`;
  - any other staging failure (`EXDEV` across file systems, a missing entry) is treated like
    a trash refusal, so `permanent` still removes the entry through `git clean`, which hands
    no path to an outside program.

  The brief said to report a failed rename in `trashUnavailable` and do nothing else. Doing
  only that would have stopped the Source Control panel's permanent discard wherever the Git
  directory sits on another file system, so only the link cases skip the permanent path.
  On Windows (no handle-based Recycle Bin call in the existing dependencies), the move keeps
  the canonical-path re-check and also refuses when a folder on the path is a reparse point
  (symlink or junction) at move time. The window left there is the PowerShell call resolving
  the path. Neither `cargo check --target x86_64-pc-windows-msvc` nor a Windows run was
  possible here (aws-lc-sys needs the MSVC headers), so CI's Windows job is the first to
  build it. Trade-offs:
  - **Put Back** in the macOS or Linux trash returns a file to the staging folder;
  - a crash between staging and trashing leaves the entry there;
  - a path through a symlinked folder that stays inside the checkout is now kept, not
    trashed. Git does not track paths beyond a symlink anyway.

  Tests: `a_folder_swapped_for_an_outside_symlink_inside_the_move_window_is_never_followed`
  (failed first: the outside file was trashed) and
  `a_refused_entry_never_goes_back_over_a_file_created_meanwhile`. The existing discard tests
  and the `git_manager` and MCP Git suites pass unchanged.

**Discard staging follow-up (coordinator, round 3).** The coordinator accepted the
link-versus-other-failure split and asked for staging as a hidden, uuid-named sibling in the
entry's own folder, so that **Put Back** returns files there and a Git directory on another disk
stops forcing permanent discard. That was rejected, and Git-directory staging kept, for two
reasons:

- **Security.** The trash resolves the staged path by string. A sibling's path runs through
  the checkout's folders, which a branch switch or pull (open to an MCP agent through
  `git_switch_branch` and `git_pull`) can replace with links. `git_status` would also list the
  staged name while it waits. So the fd chain validated at staging would not cover the path
  the trash resolves. The Git directory's folders sit outside every checkout operation and
  every MCP tool.
- **Put Back.** It would not work either way. A `.bibcode-discard-<uuid>-<name>` file reaches
  the trash under that hidden name, which Finder's Trash does not show. A holder subfolder
  makes **Put Back** aim at a hidden folder in the checkout.

The same review found the gap in the Git-directory path, and it is now fixed and tested:

- **Before the trash:** the staged path, resolved by string, must match the held handles, by
  device and inode, for the Git directory, `bibcode-discard`, the holder and the entry.
  `a_staging_folder_swapped_before_the_trash_resolves_it_is_never_followed` swaps
  `bibcode-discard` for a link to a planted entry of the same staged name. It failed first:
  the planted file was trashed. Now the trash is never called, and the entry goes back and is
  kept.
- **After a trash that answered success:** the entry must be gone from the held folder.
  `a_trash_that_did_not_take_the_staged_entry_is_never_reported_as_trashed` failed first:
  the entry was reported trashed and left staged.

The remaining window is the trash process resolving the path just after the identity check.
Only a writer inside the Git directory could use it, and such a writer could delete files
directly. The post-trash check detects it. Panel follow-ups:

- The trash dialog says **Put Back** won't return files there, except on a Windows server,
  which stages nothing.
- The permanent dialog says the trash couldn't take the files, which also covers kept links.
- After a permanent discard, the panel names any path still kept and says to remove it in a
  file manager. Until now a kept ignored file or linked-folder file closed the dialog silently.

**Review round 4 (Codex, on the batch branch).** One P1 and two P2s, all confirmed by a test
that failed first:

- **P1: Git's metadata was a valid discard target** (predates round 3). The test moved
  `.git/objects` into the trash.
  - `validate_pathspecs`, shared by stage, unstage, stash, discard and partial staging, now
    refuses a path whose first part is `.git` in any case. It already refused `./` and `..`,
    and `Path` drops a trailing slash.
  - `discard_paths` resolves the Git and common directories on every platform, and
    `contain_discard_paths` refuses a path that resolves into either (for example through
    a symlink to `.git`) or holds either.
  - Test: `git_metadata_is_never_a_discard_target` covers `.git/objects`, `.git`, `.git/`,
    `./.git/HEAD`, `.GIT/config`, a symlink to `.git`, staging `.git/config`, and a linked
    worktree's `.git` file.
- **P2: an existing `bibcode-discard` was reused unchecked.** It must now be owned by the
  server's effective uid and have no group or other write bit. Otherwise it is not used,
  and the entry counts as a trash refusal: kept on a trash request, and `permanent` still
  works through `git clean`, which needs no staging. A fresh uniquely named folder was not
  added, since it would leave a stray folder behind on every shared repository. Tests:
  `a_staging_folder_others_can_write_is_never_used` (mode `0777`) and the pure rule
  `is_private`, for another owner, which a test cannot create.
- **P2: a crash could strand a discarded file.** Before the rename, `stage` writes
  `<uuid>.origin` beside the holder (`0600`, `O_EXCL`), holding the checkout root, a NUL and
  the relative path. It is removed with the holder once the entry is trashed or put back.
  Each discard first runs `recover`: every record whose holder is not in this process's
  in-flight set has its entry moved back, by the same no-follow descent from the root and
  without replacing anything, when its place is free. Otherwise the entry stays and a
  warning is logged. Empty holders are removed with their record. Status reads do not
  recover, to keep this minimal. Test: `a_discard_restores_entries_a_crash_left_in_staging`
  stops a discard while the trash holds its entry. The next discard restores the entry,
  and a stranded entry whose place was taken stays staged.
- **Security review: recovery trusted the record.** The record held a root, and recovery
  restored into it. Anyone who could write a record into the staging folder could therefore
  move a staged entry into any folder. That needs the server's own user, since the folder
  must be private, but the record is not trusted now:
  - It holds only the entry's path below the worktree root Git reports for the Git
    directory, so a record can name no other checkout.
  - Recovery accepts only plain parts: no root, `.`, `..` or NUL, and nothing starting with
    `.git`, the `validate_pathspecs` rule. It opens the path from the worktree root through
    the same no-follow folder chain as staging.
  - Test: `a_forged_origin_record_never_moves_an_entry` covers six forged records (another
    root, `../outside`, an absolute path, a path through a symlinked folder, `.git/`, `./`).
    None moves its entry. The root case failed first: its entry was moved outside the
    checkout. The genuine stranded entry is still restored.

  Records are not signed. The server's `SecretStore` (`<state>/secrets`) would hold a
  per-user key, but the Git layer cannot reach it without threading it through
  `GitManagerRpcServices`, `lifecycle.rs` and the test setups. A record can now only send an
  entry that is already in the private staging folder back to a place inside its own
  checkout, which anyone able to write that folder could do directly. A process-random key
  was rejected too: after a restart, records written before it would be ignored, and the
  crash recovery would never run.

## P (pull request tools) implementation notes (2026-10-30)

Slice P was implemented on `claude/v0131-139-p`, from `claude/v0131-139-f0`. It adds
`mcp/tools/pull_requests.rs` and `mcp_tools_tests/pull_requests.rs`, and one registration
line in each shared file. No contract, handler or migration changed.

**Choices the design left open:**

- **The checks summary in `view_pull_request`** comes from a second read,
  `pullRequests.getChecks`, run together with `pullRequests.get` (both are in the spec's
  `methods`). It holds the host's summary, a count per state, and up to 20 failing check
  names. A checks read that fails does not fail the view: `checks` then carries its typed
  error.
- **`list_pull_requests`** sends a full `ListQuery` (`labels: []`, `sort: "newest"`, no
  filters), because the handler's struct has no serde defaults. Rows are compact (number,
  title, state, draft, author login, branches, checks and review summary, URL), and no
  row is dropped to fit: the host's cursor is opaque, so a dropped row could never be read.
- **No head-branch filter.** `ListQuery` has none; `targetBranch` is the base. An unknown
  create is resolved by reading `headBranch` on the rows. That instruction is in
  `create_pull_request`'s description, because `recorded` owns the
  `McpOutcomeUnknownError` text. The stacked action also returns an already open pull
  request for the branch (`status: "opened_existing"`), so a repeated create does not open a
  second one.
- **`draft` on create** is sent as `pullRequestOptions` only when it is true, with every
  other option empty, so other creates keep the host's own defaults. On a host other than
  GitHub or GitLab a draft create is refused by the handler's existing rule.
- **`update_pull_request`** runs `editPullRequest` (title and body, `baseBranch: null`),
  then `setDraft`, in one recorded call. When the edit lands and `setDraft` fails, it
  returns `McpPartialOutcomeError` with `updated`, `failed: "draft"`, the cause's tag and
  `code`; a keyed retry replays it, as G's branch delete does.
- **Arguments are checked at the tool:** `number` is 1 to 2^53−1, a title is non-blank and at
  most 256 characters, a body at most 65,536 (the stacked action's limits), `state` and
  `method` are from their enums, and `headSha` is required. Unknown arguments, `bypass`
  included, are refused by `only()`.
- **Merge** sends `bypass: false`, `subject: null` and `body: null`, so the host's default
  merge message applies.

**Tests.** The hosting service is faked under the real tags, and the fake decodes each
`pullRequests.*` payload with the real `ListQuery` and `ActionRequest` types, so a shape
the real handler would refuse fails the test. The unavailable-host test runs the real
`register_pull_requests_rpc` with no provider CLI or Git. The tests and the tools were
written in one pass; the first run of the suite was green.

**For the other slices.** F0's `a_capability_set_turned_off_hides_and_refuses_its_tools_live`
compared the default tool list with slice 1's tools exactly, so registering any family
failed it. P changed it (`foundation.rs`, outside P's files) to check that every slice-1
tool is listed; sibling slices that make the same change will conflict trivially. `vp run
typecheck` and `vp run check:contracts` build the server with whatever `cargo` is first on
`PATH`, so run them with the pinned toolchain first too.

**Codex review fixes (2026-10-30, `claude/v0131-139-gp-r2`).** Both findings were
confirmed in source and fixed test-first:

- **Host timeouts.** A merge or update failing with `PullRequestsOperationError` code
  `timeout`, `host_unreachable`, `invalid_response` or `output_limit` may have taken effect
  (`host_unreachable` also covers a stderr that mentions a timeout), so it is
  `McpOutcomeUnknownError` with `reason: "no-answer"` and the host's `code`, recorded
  `unknown`. An edit that landed followed by such a `setDraft` failure is the partial with
  `unknown: "draft"` instead of `failed: "draft"`, recorded `unknown`. A refusal the host
  answered stays `failed`. The create stream was not changed: its early end was already
  `unknown`.
- **Thread deletion.** `create_pull_request`, `update_pull_request` and
  `merge_pull_request` resolve the thread's folder inside the recorded work
  (`Owned::target`), so a keyed retry returns the stored outcome after the thread is
  deleted; a new call on it is still `McpThreadNotFoundError`. The stored payload is the
  arguments, not one RPC payload, as for G's push. A first call on a deleted thread now
  takes an owned slot briefly and records its `McpThreadNotFoundError` as `failed`.

**`outcome.rs` API added (shared with G):** `outcome_unknown(failure)` marks a failure
(`error.outcome = "unknown"`) that `recorded` stores as `unknown` while keeping the work's
own body, and `unknown_failure` now sets the same marker; `Interruption::NoAnswer`
(`no-answer`); and `Owned::target(thread_id)`. `target.rs` gains `thread_target` and
`live_thread`, which take the control; `ToolCall::target` and `ToolCall::thread`
(`control.rs`, one delegating line outside P's files) call them.

## D (device and browser previews) implementation notes (2026-10-30)

Slice D was implemented on `claude/v0131-139-d`, from `claude/issue-batch-after-v0.13.0` at
`882c8e4077` (slice 1, the CLI, F0 and wave 1). The 17 client twins sit beside the provider
specs in `mcp/tools/previews.rs` and reach the provider dispatch, `previews::run`; the tests
are `production/mcp_tools_tests/previews.rs`. The provider `tools/list` is unchanged: it is
still built from `preview_tool_descriptors` and `device_tool_descriptors`, which D did not
edit.

**Drift found:**

- **`McpControl` had no way to reach the preview host or the devices.** The invoker, the
  `DeviceTools` and the environment id live in `ConnectMcpService` (built in `lifecycle.rs`),
  and `ToolCall` carries only the control, the principal, the arguments and the token. `Inner`
  gained a `OnceLock<PreviewServices>` with `attach_previews` and `previews`
  (`mcp/control.rs`), and `ConnectMcpService::with_control` attaches its own
  (`production/connect_mcp.rs`). `McpControl::new` is unchanged. Without the Connect service a
  preview twin answers `PreviewAutomationNoAvailableHostError` and a device twin
  `DevicePreviewsDisabledError`.
- **Files outside D's ownership:** `mcp/control.rs` (that field, the two methods, and one
  assertion of `each_kind_is_refused_the_other_kinds_tools`); `production/connect_mcp.rs`
  (the attach, and `device_tool_descriptors` re-exported `pub(crate)`);
  `production/connect_mcp/tests.rs`, whose
  `every_listed_provider_tool_is_registered_for_providers_only` (now
  `…_with_a_client_twin_of_its_own`) and
  `providers_and_outside_agents_share_mcp_with_separate_tools_and_checks` asserted that no twin
  exists. The latter now proves the provider still reaches its own `preview_status` with its
  credential's scope, and that a client call of that name is the twin's. In
  `connect_mcp/device_tools.rs`, besides the accessor, the `DeviceTools` comment that said
  "if MCP credentials are ever issued to lower-privileged principals, both tool families
  need a scope check" now says where outside agents are checked.
- **`bibcode thread` cannot reach the twins.** Its subcommands are fixed (`list`, `start`,
  `send`, …) and it has no generic tool call. If one is added, each run mints a new session,
  so its `mcp:<sid>:<threadId>` tab assignment would not carry over between runs; key it on
  the CLI's shared label then, as `stored_request` does.
- **The missing host was not a typed error.** `run` folds every invoker failure into
  `PreviewAutomationExecutionError` with the broker's tag in the message
  (`"PreviewAutomationNoAvailableHostError: …"`). The client path splits a
  `PreviewAutomation…Error` tag back out and adds "Open BiBCode … then try again"; provider
  results are unchanged.

**Choices made while implementing:**

- **The ceiling gates every twin,** the four read-only ones too, as the design's Gates say:
  each acts in the user's preview or on a device. `tools()` lists read-only specs at a
  read-only ceiling, so those four are listed there and refused with
  `McpAccessCeilingError`. Hiding them needs a per-family list hook in `control.rs`.
- **Device twins stay listed with device previews off** (a provider's list hides them) and
  answer `DevicePreviewsDisabledError`, for the same reason.
- **Hints follow the design's list,** so the client `preview_wait_for` is not read-only and
  no twin sets `openWorldHint`, although the provider descriptors set both.
- **Arguments.** A preview twin passes every argument but `threadId` (and `tabId`, as for a
  provider) to the host, so its schema is open, as the provider's is. A device twin's schema
  is the provider tool's plus `threadId`, read from `device_tool_descriptors`, so the two
  cannot drift.
- **No `clientRequestId`.** The twins are not recorded: an open of an image the thread runs
  returns that device, and the other mutating twins act on what is on screen.
- **Results are the provider results,** unchanged: they are not cut to 80,000 characters, and
  a large `preview_snapshot` or `preview_evaluate` result can exceed the `_meta` size the
  descriptor declares.

**Tests** (written first; all nine failed before the twins existed): the listing and hints;
`threadId` required and an unknown thread refused; the scope (the agent's
`mcp:<sid>:<threadId>` session, `mcp-client`, a panel thread's host as the owner, `threadId`
and `tabId` kept from the page); no host, typed, both with and without the services; two
agents' separate tabs through a real broker and a fake UI host; read-only and the Workspace
set turned off; device twins without `DeviceTools`; and, on unix with the fake SDK,
`device_list` on and off and a close refused for another thread (`DeviceBusyError`).

**Review round 3 (Codex P2, `claude/v0131-139-r3`).** Twins bypassed F0's text-result
contract (confirmed: a 200,000-character `preview_evaluate` value came back whole, and U+202E
reached the text raw). Twin results now go through `client_result`: `structuredContent`
through `tool_result`, so the text is at most 80,000 characters (past that, `truncated` and the
standard "too long" note replace the result) and `EscapeControls` escapes hidden and control
characters, while `structuredContent` stays raw. Image content items, such as a snapshot's
screenshot, are appended unchanged, so an image never counts toward the cap. Twin failures,
including device ones, are rebuilt through `typed_tool_failure`, so their message is bounded
and made plain. `run`, the provider path, is unchanged: a test compares its result for the
same answer byte for byte. This supersedes "Results are the provider results, unchanged" above.

## T (terminals) implementation notes (2026-10-30)

Slice T was implemented on `claude/v0131-139-t`, from the batch tip `1d4eda69bd` (slice 1, the
CLI, F0, wave 1 with its review fixes, and slice D). It adds `mcp/tools/terminals.rs` (six
tools in the Terminals set) and `mcp_tools_tests/terminals.rs`, changes `terminal/history.rs`
and `terminal/manager.rs`, and adds the **What agents can use** switches and the MCP copy to
`AgentIntegrationsSection.tsx`.

**Drift found:**

- **`McpControl` could not reach the terminals.** The list and read tools need the
  `TerminalManager`, which has no RPC for either. As slice D did for previews, `Inner` gained
  a `OnceLock<TerminalServices>` with `attach_terminals` and `terminals()` (`mcp/control.rs`,
  next to `previews`), and `production/runtime.rs` attaches the manager right after
  `McpControl::new` (two lines). Without it the tools answer `McpTerminalsUnavailableError`.
  The per-terminal write locks live in that attached struct, not in a `static`.
- **Lowering the ceiling refuses but does not hide.** `McpControl::tools()` hides a tool only
  when its set is off, or a mutating one at read-only; hiding the terminal tools below Full
  access, or for a credential without `terminal:operate`, needs a per-family list hook in
  `control.rs` (as D noted for its read twins). The family refuses every call below Full
  access itself, the two reads included, with `McpAccessCeilingError` naming **Agents may**
  (and, for a connection started below Full access, saying to restart its MCP server). A
  credential without the scope gets the generic `McpScopeError`.
- **`terminal.close` has no `deleteHistory`.** `TerminalClosePayload` takes `threadId` and
  `terminalId` only, and closing removes the session with its history. `terminal_close` sends
  those two; a closed terminal then answers `McpTerminalNotFoundError`. A terminal whose
  process ended by itself stays readable, with `status: "exited"` and its `exitCode`.
- **Silent handlers.** `TerminalManager::write` returns success for an exited session, and
  `resize` for an unknown one. `terminal_write` reads the status first and answers
  `McpTerminalExitedError` (with `exitCode`); `terminal_write`, `terminal_resize` and
  `terminal_close` answer `McpTerminalNotFoundError` for a terminal the thread does not have.
- **"The UI shows it" needs a center panel.** The web adopts a server terminal only when its
  summary has `centerPanel: true` (`centerPanelAdoption.ts`), and keys it by the host thread;
  a plain drawer terminal it did not open itself never appears. `terminal_open` therefore
  sends `centerPanel: true`, and every terminal tool works on the owner thread: a chat
  panel's host (`hostThreadId`, as slice D's device owner), else the thread itself. Results
  echo the `threadId` the agent passed.
- **Capability labels.** `McpCapability::label()` (used in `McpCapabilityDisabledError`) says
  "Workspace" and "Source control", but the switches the design names are **Threads and
  worktrees** and **Source Control and pull requests**. `label()` was not changed, because
  F0's foundation test pins "Source control"; slice Z should align the two.

**Choices made while implementing:**

- **History.** `total_bytes_written` counts every pushed byte and survives `clear`, so a
  cleared terminal never reuses an old cursor. Beside the design's
  `read_window(from, max_chars)` there is `tail(max_chars)` for a read without a cursor. A
  cursor past the end (a restarted session's new history) is `dropped` too and starts at the
  oldest retained byte; one inside a character starts at the next character.
- **Read result.** `{ text, nextCursor, dropped, more, status, exitCode }`: `more` (added) says
  whether output past `nextCursor` exists. `nextCursor` is a decimal string. `cursor` and
  `tailChars` together are refused. A page whose escaped text does not fit the 80,000-character
  result (a page full of control characters) is halved, down to 500 characters.
- **Stripping.** Besides CSI and OSC, DCS, SOS, PM and APC strings and two-byte escapes
  (`ESC 7`, `ESC ( B`) are removed. An escape cut at the page's end is left for the next page,
  with `nextCursor` before it, unless it starts the page.
- **Write result.** `terminal_write` returns `cursor`, the output offset just before its data
  went in, so `terminal_read { cursor }` shows what the command printed.
- **Recorded rows.** `terminal_open` mints `mcp-<uuid>` before `recorded`, so a keyed retry
  answers with the same terminal. A keyed write stores `{ threadId, terminalId, chars }`, never
  the data; the arguments' digest still binds a retry to the same data.
- **Resize and close** are not recorded and run inline (`ToolCall::invoke`). Resize sends no
  size claim, as an older client does.
- **Defaults.** `terminal_open` uses the handler's 120 × 30 unless `cols` and `rows` (1 to
  1,000 and 1 to 500) are given.
- **UI.** The group sits under **Agents may**. A switch shows the stored value; Terminals is
  disabled with "Set Agents may to Full access first." below Full access, and every switch with
  the row above's reason ("Turn on MCP server first.", or the older-server and connecting
  reasons). A reset sets all five to their defaults. The access description keeps its restart
  sentence after the design's new text, because it is still true. The Terminals description
  keeps the design's "or after a remote agent reauthorizes", which becomes reachable with R.

**Tests.** History windows, the dropped and past-the-end cursors, and the tail are unit tests
in `history.rs`; `manager.rs` tests the per-thread list and the read. The tool tests run the
real `terminal.*` handlers on an echoing fake PTY, and one on a real `/bin/sh` (`cfg(unix)`):
`echo $((40+2))` is read back as `42`, and a read from the cursor holds only the next
command's output. The log-and-profiler test runs in its own process with a captured `TRACE`
subscriber and a running profiler, and finds no canary from the input, the output, a refused
write or a write to a missing terminal. The interleaving test passes without the tool's lock,
since the manager already serializes a terminal's writes (its publication lock, and the PTY
writer's lock); the lock keeps the guarantee in the tool layer, as the design asks.

**Codex review fixes (round 2, 2026-10-31).** Each finding was checked in source and fixed
test-first; these supersede the notes above where they differ.

- **P1, a write could block a runtime worker (verified).** `TerminalManager::write` called the
  PTY's synchronous `write_all` inside the publication lock. It now checks the session under
  that lock, releases it, and runs the write with `spawn_blocking`, ordered by a per-generation
  `unary_writes` lock that the blocking thread holds until the bytes are in, so a dropped call
  never lets a later write overtake a stuck one. The ordered `write_input` path (the UI's
  normal input) keeps its write inside the poll, because `PreparedTerminalInput::write` runs it
  again when its admission is replaced and an abandoned handed-off write would send the frame
  twice; it uses `block_in_place` on a multi-thread runtime (inline on a current-thread one)
  and still holds the publication lock, which the output publisher only awaits. `terminal_write`
  gives the write 10 s; past that it is `McpOutcomeUnknownError` (`reason: "no-answer"`),
  recorded `unknown`, while the write goes on in the manager and later writes queue behind it.
  At most one blocking thread per terminal generation waits on a stuck PTY.
- **P2, success after the process exited (partly refuted).** The `Ok(())` branch for an exited
  session was unreachable: both exit paths invalidate the generation before they mark the
  session exited, under the publication lock, so a write after an exit already failed, as
  `TerminalSessionLookupError`, not success. The manager now answers that case
  `TerminalNotRunningError`, which `write_input` already did, and `terminal_write` maps it to
  `McpTerminalExitedError`. An exit after the check and before the syscall is inherent; the
  write then reaches a dead PTY.
- **P3, a cursor from before a restart (verified).** A cursor is now `<epoch>:<offset>`: every
  `TerminalHistory` takes an epoch unique in the process, so a restart or a reopened terminal
  id answers an old cursor with `dropped: true` from the oldest byte. This replaces the
  decimal `nextCursor` above.
- **P4, an escape that fills the page (verified).** When the whole page is one unfinished
  escape, the read looks at the retained output (at most 1 MiB, in memory): it moves
  `nextCursor` past the sequence when its end is there, and keeps it at the sequence's start
  while it is still arriving. A `tail` or `dropped` window that starts inside a sequence can
  still show its continuation as text; that is not this finding and stays a known gap.
- **Tests.** Manager: a blocked unary write leaves the runtime's only worker and the
  publication lock free; a blocked ordered write leaves the worker free; a unary write after an
  exit is `NotRunning`. History: a cursor of another history is dropped, and cursors round-trip.
  Tools: a stuck write answers unknown within the timeout, twice with one key, and lands once;
  a pre-restart cursor is dropped; an escape longer than a page is skipped whole; an escape
  still arriving keeps the cursor.

**Codex review fixes (round 3, 2026-10-31).** These supersede round 2's write paths.

- **P1, a stuck MCP write could still freeze publication (verified).** Round 2's ordered path
  held the publication lock while its `block_in_place` write waited for the PTY. Both paths now
  go through a per-process `terminal/writer.rs` `TerminalWriter`: the caller checks the session
  and enqueues under the publication lock without waiting, and the writer's own thread writes
  the queue in order outside it. A stuck write therefore blocks only the writes queued behind
  it; output publication, exit handling, `clear` and `close` go on. The ordered frame is
  queued in the poll that returns, so an admission replacement before it retries and one
  after it only changes whose loss is watched: no frame is queued twice. Loss of the current
  admission, or dropping the frame's call, drops a queued frame the writer has not started; a
  unary write stays queued when its call is dropped (the MCP timeout's "it may still go in").
- **P2, timed-out writes could exhaust the blocking pool (verified).** PTY writes no longer
  use `spawn_blocking`. A process with input has one `terminal-input` thread, which retires
  after 30 s idle, and at most 1 MiB queued or in flight; past that a write is refused at once
  ("its input queue is full", `TerminalError::Io`). A stuck terminal holds one thread and one
  bounded queue; the number of terminals is not bounded here.
- **P3, epochs collided across server restarts (verified).** The epoch counter starts at a
  random 64-bit value per server lifetime, so a reopened terminal id after a restart no longer
  matches a kept cursor.
- **Refuted, as the coordinator decided:** rejecting the round-1 decimal cursors needs no
  compatibility path, since the terminal tools are unreleased.
- **Tests.** Manager: a stuck unary write, then typing on the same terminal, while `clear` and
  `close` finish; queued typing is dropped when its admission is lost, without waiting for the
  stuck write; two stuck terminals leave a one-thread blocking pool free; a writer refuses
  input past 1 MiB and takes it again once drained. History: two processes' first epochs
  differ (each phase re-executes the test in a process of its own).

**Codex review fixes (round 4, 2026-10-31).**

- **An OSC color query could stall output behind a stuck write (verified).** The PTY reader
  answered OSC color queries itself, through the PTY writer mutex that a stuck input write
  holds. Replies now go to a `bibcode-pty-osc-<pid>` thread over a bounded channel (16
  replies; one that does not fit is dropped, which only leaves the provider on its default
  theme). The reader never waits on the writer, and the thread ends with the reader at the end
  of the output. Replies do not go through the manager's `TerminalWriter`: the responder is a
  `PortablePtyBackend` detail below the manager, and a reply's order against queued input does
  not matter.
- **Close and shutdown kept idle writer threads and PTY handles (verified).** The writer thread
  held the queue that held its own sender, so only the 30 s idle timeout ended it.
  `TerminalWriter::stop` now drops the only sender outside the thread and refuses later input;
  input still queued is answered as cancelled, and the thread ends, releasing the process,
  once any write in the kernel returns, which the process's end makes fail.
  `SessionGeneration::invalidate` calls it, so close, exit, restart and shutdown all stop the
  writer. Nothing waits for the thread, so a write stuck in the kernel leaves only a detached
  thread and never holds up shutdown.
- **Tests.** PTY: with the writer held, the output after an OSC color query is still
  published, and the reply goes in once the writer is free. Manager: close and shutdown each
  end a terminal's writer thread within 2 s.

## X2 (diagnostics tools) implementation notes (2026-10-30)

X2 was implemented on `claude/v0131-139-x2`, from the batch tip `1d4eda69bd` (slice 1, the
CLI, F0, wave 1 and D). It adds `mcp/tools/diagnostics.rs` (the eight tools and their
projections) and `production/mcp_tools_tests/diagnostics.rs`, changes
`diagnostics/profiler/mcp.rs` and `diagnostics/profiler/git_actions.rs`, and adds one
registration line each in `mcp/tools/mod.rs`, `control::FAMILIES` and `mcp_tools_tests/mod.rs`.
No contract, migration, RPC method or `latency.rs` entry changed.

**Revision 4 requirements:**

- **Rejected action text (X2).** `record_stacked_action_outcome` maps `action` to one of the
  five names `validate_stacked_action_input` accepts, or `unknown`, before anything uses it,
  so the event, the repeat key, the finding's fingerprint, summary and evidence all carry
  the normalized name. Fixing only the event would have left the finding's `summary` and
  `evidence.action` returning the client's text through `profiler_status` and
  `profiler_findings`. The test records a marker action as `git.runStackedAction` passes it
  (once refused, three times failing to raise the finding) with a live profiler, and reads
  both back over `/mcp`; it failed with the normalization removed.
- **Event allowlist (X2).** `profiler_events` and `profiler_crash`'s `lastEvents` keep the
  envelope (`v`, `bibcode`, `ts`, `sid`, `seq`, `eventId`, `kind`, `source`) and the payload
  fields `events.md` documents for the kind (`event_fields`); an undocumented kind keeps its
  envelope only. Lists inside an event (`procs`, `frames`, `histograms`) keep their
  documented fields, `stalls` and `interactions` their numbers. Client-chosen strings
  (`clientId`, `correlationId`, `envId`, `appVersion`, and `source`'s `client:<id>`) are kept
  only when id-shaped (`[A-Za-z0-9._:+-]{1,64}`), and a client batch's `capabilities` only
  when known. A crash record keeps its documented fields, its frames' files go through
  `redact_path` and `stackError` through `redact_message`.
- **Findings cursor (X8).** Without `since` or `cursor`, `profiler_findings` is unchanged
  (the newest `limit`, newest first). With either, findings at or after `since` and after
  `cursor` come oldest first by parsed `lastSeen`, then id, at most 100 a page, with
  `nextCursor` (`<lastSeen>|<id>`, opaque to agents) while more remain and null at the end.
  The page is fitted (`fit_list`) before the cursor is set. A finding that recurs moves to
  its new `lastSeen`, so a reader following the cursor sees it again; at most the book's
  1,000 findings are ever held. The stdio server gets the same cursor (same handler): its
  only visible change is that `since` now returns oldest first. Its tests and the skill's
  tool line say so.

**Drift found:**

- **"Each profiler tool over `/mcp` matches the stdio result"** holds for `profiler_status`
  and `profiler_findings`. For `profiler_events` and `profiler_crash` the Revision 4
  allowlist supersedes it: the test asserts `/mcp` equals the stdio events, each projected.
  The stdio server keeps returning raw events: it is a person's own tool over files they can
  read, and the requirement names records returned to outside agents.
- **The handlers' seam.** The stdio handlers returned a finished `tool_result`, which cuts
  after any cursor and leaves no room to project, so each became a `pub(crate)` content
  producer returning `(content, cuts)` and a `Refusal` (`Invalid` or `Missing`) that the stdio
  server turns into `tool_failure` and `/mcp` into `McpInvalidArgumentError` or
  `McpCrashNotFoundError`. Their descriptions and schemas are `pub(crate)` too.
- **Reaching the server's own directory.** `McpControl` holds no state directory, and
  `control.rs` is X1's in this wave, so `profiler::mcp::server_reader()` builds a `Reader`
  from the installed `ProfilerHandle`'s directory (a child module may read its private
  field). The runtime installs the handle with recording off too, so the tools read the
  files either way, as the stdio server does. With no handle (no runtime, or one that could
  not lock its directory) the tools return `McpProfilerUnavailableError`.
- **`diagnose_environment` and `discoverSourceControl`.** Discovery is already long-running
  in `latency.rs`, so `mcp.diagnose_environment` is too, through its method; nothing was
  added there. `refresh_providers` is long-running through `server.refreshProviders`. The
  tool sends `{}`: `recordHosts` rewrites the recorded hosts, which only Settings' scan does.
- **Files touched beyond X2's.** F0's
  `a_capability_set_turned_off_hides_and_refuses_its_tools_live` (`foundation.rs`) asserted
  an empty list with Workspace and Source control off; Diagnostics is on by default, so it
  now asserts that only Diagnostics tools remain. The docs beyond `docs/user/mcp.md`:
  `rpc-and-orchestration.md` (a "Diagnostics tools" subsection, per the Docs section),
  `overview.md`, and the profiler skill's `SKILL.md`, `events.md` and `findings.md`; the
  skill's frontmatter is unchanged, so its stubs are too.

**Choices made while implementing:**

- **`diagnose_environment`** returns `environment` (server version, platform, remote
  protocol versions, and the capability flags that are numbers or booleans under plain
  keys), `providers` (`instanceId`, `driver`, `enabled`, `installed`, `version`, `status`,
  `availability`, and `auth` as its status), `configIssues` (a count per kind),
  `sourceControl` (each system's and CLI's kind, status, version, and a CLI's sign-in
  status; no executable, hint, detail, host or account) and `profiler` (its state without
  findings). A section whose RPC fails carries its error's tag instead of failing the call.
- **`refresh_providers`** is an operate tool marked idempotent, not recorded, and returns
  the same provider projection.
- **`process_diagnostics`** takes `historyWindowMs` (15 minutes unless set, clamped to one
  minute to one hour) and `bucketMs` (a fifteenth of the window unless set, clamped so there
  are at most 120 buckets and none under a second), since the RPC has no defaults. An error
  becomes `readFailed: true`; `uiCoverage` keeps its status only.
- **`trace_diagnostics`** takes `limit` (1 to 20, 10 unless set) per list, returns no trace
  or span ids, and keeps the error's `kind` only.

**Tests** (`production/mcp_tools_tests/diagnostics.rs`): listing, hints, read-only and the
set turned off; process and trace projections against the real wire shapes with a marker in
every free-text field and a home path in every path; `diagnose_environment` the same, and
that discovery is never asked to record hosts; `refresh_providers`; and two tests in
processes of their own (the profiler handle is process-global): the profiler tools over a
real runtime and store (unavailable before it starts, status and findings equal to stdio,
events and crash projected, typed refusals), and the rejected action. The cursor is tested
on the stdio server (`a_cursor_catches_up_more_than_100_findings_oldest_first`: 250 findings,
ties on `lastSeen` broken by id) and over `/mcp` for its refusal. The git action and cursor
tests were each seen failing before their fix.

**Codex review fixes (review round 2, 2026-10-31).** All four P2s were confirmed in source
and fixed test first; each new test was seen failing against the round-one code:

- **Findings were returned unprojected.** Confirmed: a `client.stall` finding's evidence held
  the batch's `clientId`, and a `git.stacked-action-failed` finding's `evidence.worktree` is
  absolute outside home (`redact_path` only replaces home). `profiler_status` and
  `profiler_findings` now project each finding (`project_finding`): its documented fields
  without `title` and `summary` (prose that quotes paths, such as `Panic at <location>` and the
  worktree audit's `<path> is …`), and only its kind's evidence fields from `findings.md`
  (`evidence_fields`) plus `eventIds`, `crashId` and `crashIds`. Free text (`exitDetail`,
  `journal`) is left out. A `worktree` or `path` is kept only inside home (`~/…`); `location`,
  `exe` and a path-shaped `rawRef` keep a relative path or the file name. So the stdio equality
  for these two tools no longer holds either: the test asserts `/mcp` equals the stdio findings,
  each projected.
- **Id-shaped client strings passed.** Confirmed: the shape check let `privateToken123`
  through. `clientId`, here and in findings, becomes `h` and 12 hex characters of SHA-256 over
  it, so one client still matches across events and findings and a `client:<clientId>` source
  becomes `client:<hash>`. `correlationId` and `appVersion` are left out. `envId` is the
  server's own and is kept.
- **Frame files kept build paths.** Confirmed. A symbolicated frame's `file`, like a panic's
  `location`, keeps a relative path (`apps/server/src/…`) or the file name of a rooted one
  (`/…`, `~/…`, `C:\…`), with any `:line` kept.
- **The cursor skipped same-second changes.** Confirmed: `lastSeen` is whole seconds
  (`findings.rs` drops the nanoseconds) and the book keeps no durable position (the file is
  rewritten on compaction, and `seq` is per writer session). The cursor is now
  `<second>|<marks>`: the second its page ended in and a 12-hex SHA-256 mark of each finding's
  id and count it returned in that second. The next page reads that second again and returns
  any finding not marked, so a finding written into it later and a recurrence (a new count) both
  come, and nothing already read repeats. Marks for that second carry over while pages keep
  ending in it; a cursor is at most 16,384 characters (a mark for each of the book's 1,000
  findings). The disk's own lag (a count persisted only at powers of two or a minute later) is
  unchanged.

Tests: `a_cursor_replays_its_last_second_and_returns_what_changed_in_it` (stdio: a new finding
sorting before the page's last in the same second, and a recurrence of one read);
`a_crash_frame_keeps_a_relative_path_or_the_file_name_only`; and the own-process store test,
now with a client stall, a failing action outside home, a worktree path in home, a panic
location, an id-shaped `clientId`, `correlationId` and `appVersion`, and those in a crash's
`lastEvents`.

**Codex review fixes (review round 3, 2026-10-31).** All four P2s were confirmed and fixed
test first; each new test was seen failing against the round-two code:

- **OS crash paths.** Confirmed: `crash.native` (and `crash.webview`, `subprocess.crash`)
  evidence kept `module`, `faultModule` and each frame's module as the host path. They now keep
  a relative path or the file name; a frame `symbol (module + 0xoffset)` or
  `module + 0xoffset` is rebuilt around its module's file name, so a module path with spaces
  is reduced too. A panic event's frame `module` is reduced the same way.
- **Guessable client ids.** Confirmed: the alias was an unsalted digest. It is now
  HMAC-SHA-256 under a 32-byte key drawn once per server process with `getrandom`, never
  stored or returned, so an alias matches across events and findings within one run and
  changes on restart (chosen over a persisted key: correlation is only needed while an agent
  reads one run's records). If no key can be drawn, the id is left out.
- **A busy second outgrew its cursor.** Confirmed: every `(id, count)` mark was appended,
  earlier counts of a recurring finding included. A mark is now a 10-hex id mark and a 6-hex
  count mark (the count's low 24 bits), at most one per finding: a page overwrites the count
  of a finding it read again, and marks of findings no longer in that second are dropped. The
  limit is derived from the book (`64 + MAX_FINDINGS × 17` = 17,064 characters, with
  `MAX_FINDINGS` now `pub(super)` in `findings.rs`), so every cursor the server emits parses.
- **A large page lost its cursor.** Confirmed: the page was fitted with 256 characters of
  room, and a long cursor then pushed the result over 80,000 characters, which the formatter
  replaces with its note. The `/mcp` page is now projected first
  (`profiler::findings_page(reader, arguments, project_finding)`) and fitted with its actual
  cursor, dropping findings from its end and recomputing the cursor until `tool_result` would
  return it whole. A finding too large alone comes without `evidence` and with
  `evidenceOmitted: true`, so each page returns at least one finding.

Tests: `a_busy_second_with_recurrences_keeps_its_cursor_within_the_limit` (1,000 findings in
one second, half read, all recurring twice), `a_large_page_keeps_its_cursor_and_makes_progress`
(899 small findings building a long cursor, 100 large ones in the same second, one of 90,000
characters), `a_crash_records_modules_and_frames_keep_file_names_only` and
`a_client_alias_is_keyed_not_a_plain_digest`.

**Codex review fix (review round 4, 2026-10-31).** Confirmed: a panic's `message` reached
outside agents in `panic` events, in `crash.panic` findings' evidence and in a crash record's
`lastEvents`, and the panic hook redacts only home paths, so `failed opening
/mnt/private/customer.txt` passed. `message` is now left out of both `/mcp` allowlists
(`event_fields("panic")` and `evidence_fields("crash.panic")`); `lastEvents` go through the
same event projection. Agents keep the kind, thread, location (a relative path or file name)
and frames. The stdio server is unchanged. The own-process store test now holds that message
in a panic event, a `crash.panic` finding and a crash's `lastEvents`, and asserts it in none of
`profiler_status`, `profiler_findings`, `profiler_events` or `profiler_crash`; it failed before
the fix. This supersedes round one's choice to keep the panic message.

## X1 implementation notes (2026-10-31)

X1 was implemented on `claude/v0131-139-x1`, from `1d4eda69bd` (slice 1, the CLI, F0, wave 1
with its review fixes, and slice D). Migration 60 is `McpActorAttribution`. Nothing below
changes a settled decision; it records drift and the APIs X3 to X6 build on.

**APIs later slices plug into:**

- **Actor.** `mcp::activity::principal_actor(&RpcSessionContext) -> Option<Value>` is
  `{ kind: "mcp-client", clientId: <session id>, label }` for an `mcp-client` principal.
  `CommandAdmissionClaim::attribute_to(actor)` (engine) attributes every event a command plans;
  a handler that acquires its own claim (X4's panel tools go through `worktree.createPanel`,
  which already does it) calls it right after acquiring. The engine reads the actor only from
  the claim, never from the command.
- **Projections.** `ProjectionThreadMessage.actor` / `.source_thread_id` and
  `ProjectionThread.requester` (`{ actor, purpose }`), from `actor_json`, `source_thread_id`
  and `requester_json`. `thread.turn.start`'s `message.sourceThreadId` is accepted from any
  client, checked to be a live thread of the same project, carried on the
  `thread.message-sent` payload and projected; X4 decides who may set it and renders it.
- **Purpose.** `thread.create.purpose`, `bootstrap.createThread.purpose`,
  `worktree.createManaged.purpose` and `worktree.createPanel.purpose` (at most 200
  characters, an engine invariant). Tools read it with `ToolCall::purpose()` and describe it
  with `activity::PURPOSE`.
- **Activity.** `McpControl::activity()` is the `McpActivity`: `record(NewActivity)`,
  `recent()`, `active()`, `call_started`, `owned_changed`. Rows are written by the one hook
  in `call_in`; a family adds no code. The target is extracted from the arguments and the
  result's `structuredContent` by `activity::target`, which keeps only `sha`, `revertedSha`,
  `pullRequest` (from `number`), `worktreeKey`, `fileCount` (from `paths`), `cloneId` and
  `transferId`; X5 and X6 return `transferId`/`cloneId` in their results to have them
  recorded. X3's `changes_since` reads `mcp_activity` by `activity_id`, which is monotonic.
- **Stop and Take over.** `AuthService::stop_client`, `subscribe_mcp_stops`, `client_label`
  and `set_mcp_access` (`McpAccessChange`); `activity::interrupt_turns_of(control, session)`.

**Drift found:**

- **`start_thread` does not send `thread.create`.** It sends `thread.turn.start` with
  `bootstrap.createThread`, so `purpose` is on both, and the engine checks the length on both.
- **Actor through the claim, not a command field.** The command's admission claim is the one
  server-held object every dispatch path (unary, turn start, worktree handlers) hands to the
  engine worker, so the actor rides on it (`OnceLock`) and `process_envelope` stamps the
  planned events after `plan_command`, including the turn-delivery event a turn start adds.
- **Stop needs a flag on the revoke route.** The `bibcode thread` CLI revokes its own
  credential on the way out, so interrupting on every revocation would cancel the turn
  `bibcode thread start` just started. `RevokeClientRequest` gains `interruptTurns`; only a
  revocation made with it is announced (a broadcast of its own, not the access events, whose
  subscription would keep the authority watcher alive). Revoke in the Agents list sends the
  plain body and leaves turns running. The interrupt goes through `orchestration.dispatchCommand`
  with an unauthenticated server context, so the provider is told, as for the UI's stop button.
- **Take over stores the level it replaced.** `auth_sessions.mcp_access_hand_back` (in
  migration 60, beyond the design's table list) is read back by the authority snapshot, so
  Hand back survives restarts and other processes. The route accepts `read-only`, or exactly
  the stored level; anything else, an unknown or revoked session and a person's session are
  one 400 `invalid_mcp_access` (the HTTP contract has no 404/409 shapes for auth routes). The
  route cancels the session's live tokens without removing them, so connection counts stay
  right; owned work it interrupts records `revoked`, since `LiveControls` sees the
  revocation token, not the new level.
- **The HTTP route needed contract and fixture work outside X1's rows:** `http.rs`
  `ROUTE_INVENTORY` (R's file), `environmentHttp.ts` `setMcpAccess`, `auth.ts`
  (`AuthSetMcpAccessInput`, `interruptTurns`, `mcpAccess`/`mcpAccessHandBack` on
  `AuthClientSession`), the auth fixture exporter and `authRustParity.test.ts`, and the web
  test HTTP harness. The RPC fixture counts (methods 178, streams 28, stream shapes 88,
  fixtures 495) moved in the exporter, its test and `tests/rpc_wire.rs`.
- **Retry detection is a read, not a sink.** A keyed call is a retry when its
  `clientRequestId` already has a live `mcp_tool_requests` row before the call runs; this
  keeps `outcome.rs` and every family untouched. Two concurrent first calls with one key can
  each record a row (only one runs the work). A keyed call cancelled while its owned
  mutation goes on (`McpCancelledError`) polls the row every 2 s, up to 35 minutes, and
  records the stored outcome.
- **Rows are written for refusals the handler returns** (an unknown thread, a bad
  argument), not for calls refused at the gate (off, scope, capability, read-only, busy).
- **No app header exists.** The indicator sits in the status bar beside the profiler marker,
  which every screen shows. It names the most recent active agent (with `+N`) and offers its
  Stop and Take over or Hand back; the Agents list covers every agent.
- **Primary environment only.** Watching and managing agents uses the primary environment's
  HTTP client and `access:read`/`access:write`, as **Authorized clients** does, so the
  status bar, the Agents list and the commit chip show the primary environment's agents.
  Message and thread chips come from the thread data and show in every environment.
- **Panel tabs show no chip.** Center panel tabs render surfaces, not threads; the panel's
  thread carries `requester` and its messages their actor. X4, which owns the panel
  provenance UI, can add it to the tab.
- **`production/runtime.rs`** (X5's file in W3) gained the activity service and its stream
  registration before the registry is finished; `McpControl::new_with_activity` takes it,
  and `McpControl::new` builds its own for tests.
- **Shared test files.** `mcp_tools_tests/worktrees.rs`'s `Fixture` became `pub(super)` so
  the attribution tests reuse it; three `AppStatusBar` tests mock the new indicator, and
  `CreateWorktreeDialog.settings.dom.test.tsx` and `SourceControlCommits.behavior.test.tsx`
  mock `~/state/mcpActivity`.

**Tests:** `production::mcp_tools_tests::attribution` (actor on every event of an MCP start
and none for a person's, an injected `actor`/`metadata` ignored, message actor and thread
requester in the projection, `read_thread` and the shell snapshot; purpose length;
one activity row per mutating call, none per read or retry, a failure's tag; Stop revoking,
interrupting the agent's running turn but not a person's, cancelling owned work, and a plain
revocation interrupting nothing; Take over refusing mutations and stopping owned work,
Hand back restoring only the stored level; `create_worktree` and a panel stamping their
threads), `mcp::activity::tests` (the stream's snapshot, row and active events; pruning;
targets keep ids only), migration 60, and web tests for the chip, the status-bar indicator,
the Agents panel, the commit labels and the reducer's actor. The tests were written with the
code, not each one failing first.

**Codex review, round 2 (2026-10-31).** All three P2s were confirmed in source and fixed, each
with a test that failed first:

- **Stop after Revoke.** `stop_client` announced only a session it revoked itself, so Revoke
  then Stop answered `revoked: false` and interrupted nothing, and the web called that
  success. It now also announces an `mcp-client` session revoked earlier (read from
  `auth_sessions`), and answers `false` only for an unknown session or a revoked one that was
  not an agent's; `stopMcpAgent` throws on `false`, so the toast says the stop did not happen.
- **A long turn lost its Stop.** `active` ended two minutes after the last call. An agent with
  a running turn whose latest sent user message carries its actor is now active, revoked or
  not, with `McpActiveClient.runningTurns` (contract, decoding default 0). The query is shared
  with Stop's (`attributed_running_turns`); streams run it on the snapshot and each 15 s
  re-check and reuse it on presence changes. The indicator keeps Stop (and drops Take over for
  a revoked agent), and the Agents list shows Stop for agents with running turns and lists a
  revoked one as **Revoked** with Stop only.
- **Idle retention.** `recent()` now deletes rows past 7 days and filters by that cutoff, so a
  later subscriber never sees older rows even when nothing was written; a periodic sweep was
  not needed.
- **Not changed:** the forged `sourceThreadId` finding is X4's (see the APIs above).

## X3 implementation notes (2026-10-31)

X3 was implemented on `claude/v0131-139-x3`, from the batch tip `8d400e20df` (slice 1, the
CLI, F0, wave 1, D, T, X2, X1 and their review fixes). It adds `mcp/tools/feed.rs`
(`server_capabilities`, `changes_since` and the error table), the transition read in
`persistence/repositories.rs` (`change_feed_heads`, `read_change_feed`) and
`production/mcp_tools_tests/feed.rs`, with one registration line each in
`mcp/tools/mod.rs`, `control::FAMILIES` and `mcp_tools_tests/mod.rs`. No contract,
migration, RPC method or `latency.rs` entry changed.

**The relay check (the section's "verify … and fix it here if not").** Slice 1's relay did
not: a `tools/call` refused with 401 answered an untyped `tool_failure(REVOKED_MESSAGE)`, and
one it could not deliver answered a JSON-RPC `INTERNAL_ERROR`, not a tool result. `relay.rs`
(outside X3's row, by the section's own instruction) now answers a `tools/call` with
`McpCredentialRefusedError` (401), `McpServerUnreachableError` (no server after one
rediscovery) or `McpSignInError` (minting or the token exchange failed), each a typed tool
result with the same message as before; every other request keeps its JSON-RPC error.
`mcp/relay/tests.rs` asserts the tag on the existing revocation test and adds a server that
stopped mid-session. A remote HTTP client still gets the 401 itself; the table says so.

**Drift and choices the design left open:**

- **Version source.** `server_capabilities` reads `CARGO_PKG_VERSION` (as `serverInfo` and
  `ServerConfig::server_version`'s default do), `protocol::VERSIONS` and the remote protocol
  constants, not the environment descriptor: `McpControl` holds no `ServerConfig`, and
  `server.getConfig` carries paths and `mcpLaunch`. The values are the descriptor's own.
- **`toolsVersion`** is the first 8 bytes, in hex, of the SHA-256 of the principal's
  `tools/list` array, so a ceiling, capability or tool change moves it.
- **The error table** (`feed::ERRORS`) holds every `Mcp…Error` tag the MCP layer writes, plus
  `idempotency_conflict`, `UpdateMaintenanceActiveError`, and the three preview and device
  tags slice D names; `otherErrors` says any other tag is the operation's own error. A unit
  test scans `mcp/**` and `rpc/session.rs` for `"Mcp…Error"` literals and fails on one the
  table lacks (`McpEndpointProofError` and `McpActivityError` are no tool results). **For the
  combiner:** X4, X5 and X6 add families under `mcp/tools/` in this wave; any new
  `Mcp…Error` tag they write fails
  `mcp::tools::feed::tests::the_error_table_holds_every_tag_the_mcp_sources_return` until it
  gets a row in `ERRORS`.
- **Entry shape.** Beyond `{ cursor, at, kind, threadId?, status?, requestId?, actor? }`, an
  agent-activity entry carries `tool` and `target` (X1's ids-and-counts target). Both are ids,
  never text; without them an `agent.call` entry could not say what ran.
- **Kinds.** One entry per event at most, so every entry has a cursor of its own:

  | Event                                                      | Entry                                                                           |
  | ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
  | `thread.created` (`kind: panel`)                           | `thread.created` (`panel.created`)                                              |
  | `thread.archived`                                          | `thread.archived`                                                               |
  | `thread.turn-start-requested`                              | `turn.requested` (added: the event a message carries its actor on)              |
  | `thread.session-set` running with a new `activeTurnId`     | `turn.started`, `status: running`                                               |
  | `thread.session-set` leaving running                       | `turn.failed` (error), `turn.interrupted`, else `turn.completed`; `status` kept |
  | other `thread.session-set` whose status changed            | `session.status`                                                                |
  | `approval.requested` / `.resolved` / `.expired` activity   | `approval.requested` / `approval.resolved` (`status: resolved` or `expired`)    |
  | `user-input.requested` / `.resolved` / `.expired` activity | `input.requested` / `input.resolved` (the same)                                 |
  | an `mcp_activity` row                                      | `agent.call` with `tool`, `target`, `status` (the outcome tag) and `actor`      |

  A session update reads the thread's previous session update (`json_array` of its status and
  turn, through the stream index) in the same query, which is what makes start and end
  stateless per row. A compaction's own turn is reported as a turn too. Thread deletion and
  unarchive are not in the design's list and are not reported.

- **Content stays in SQLite.** The read selects `sequence`, `event_type`, `stream_id`,
  `occurred_at` and `json_extract`ed ids and enums only; payload text never reaches Rust.
  `requestId` is kept up to 256 characters without control characters, and an actor keeps its
  `kind`, `clientId` and `label`.
- **Paging.** A page lists the scanned window's transitions first, then activity rows, each
  entry with the cursor just after it (`v1.<sequence>.<activityId>`), so cursors increase
  strictly, componentwise. Every event of the window examined, the page cursor's sequence is
  the window's last (progress even with no match); a page cut by `limit` or by the 80,000
  characters (`fit_list`, at least one entry) ends at its last entry. `more` is true then, or
  when the window hit 5,000 events. Interleaving the two logs by time was rejected:
  `occurred_at` is not monotonic in `sequence`, so a time merge would break the cursor order.
- **Filter.** `threadId` scans that thread's events through `idx_orch_events_stream_sequence`
  (up to 5,000 of them) and its activity rows. The description says to keep one cursor per
  filter, since a filtered cursor's sequence can pass other threads' events.
- **`activityDropped`** is `cursor.activityId + 1 < MIN(activity_id)`, or, when every row is
  pruned, `cursor.activityId < sqlite_sequence.seq` for `mcp_activity` (AUTOINCREMENT keeps
  it). It looks at the whole table, also under a filter.
- **A cursor ahead of either head** (from another database) is `McpInvalidArgumentError`, as
  is a malformed one; the message says to start again without a cursor.
- **`foundation.rs`** (`a_capability_set_turned_off_hides_and_refuses_its_tools_live`) asserted
  that only Diagnostics tools remain with Workspace and Source control off; it now allows the
  tools of no set too.

**For X8.** A webhook payload carries the entry's `cursor`; a receiver that missed deliveries
calls `changes_since { cursor }` with the last one it has and repeats while `more` is true.
`profiler.finding` is not in this feed: X2's `profiler_findings { since }` cursor covers it.
An entry's `kind`, `threadId`, `status`, `requestId` and `actor` are the webhook's natural
event fields.

**For X7.** Source Control reads are not in the feed (no durable record). Its commit
message tools add no kinds here.

**Tests** (written first; all failed against a stub family and the old relay):
`production::mcp_tools_tests::feed` covers listing and calls at read-only with every set off;
the capabilities (versions, ceiling, sets, scopes, error rows, `toolsVersion` stable and
moved by a set or the ceiling); no cursor starting from now; a full agent turn and an
approval whose prompt, reply, summary and purpose markers never appear, with strictly
increasing cursors, resumable from any entry's cursor and through `limit: 2` pages; the
`threadId` filter on both logs; the 5,000-event scan returning its progress; `activityDropped`
after pruning, also with every row gone; refused cursors and limits; and a transition
written to the file database while no server ran, read with the old cursor after a restart.
`mcp::tools::feed::tests` covers the cursor's parsing, the session mapping and the error
table scan; `mcp::relay::tests` the two typed relay failures.

**Codex review round 2 (2026-10-31).** Both P2s were confirmed in source and fixed
test-first on `claude/v0131-139-x3`:

- **Provider text through `requestId`.** OpenCode passes its provider's request id through
  unchanged, so a path or words in it reached `changes_since`, which needs no Workspace set.
  An entry now carries `requestId` only when it matches `[A-Za-z0-9_.:-]{1,128}`; otherwise
  it is left out and `list_pending_requests` (Workspace) names it, which is where
  `answer_approval` takes its id from anyway. An alias was rejected: `answer_approval` would
  need to resolve it, for ids that real providers do not produce. Test:
  `a_request_id_that_is_not_a_plain_id_is_left_out` (a path with spaces).
- **Bytes parsed per call.** Filtering by type alone does not bound it: tool output arrives
  as `thread.activity-appended`, the same type as approvals, and the kind is inside the
  payload. A lower window does not bound bytes either, and narrow columns need a migration.
  The window is now also cut by bytes: each event in it costs its payload's
  `octet_length` when its type is one of the five the read parses (0 otherwise), and the
  window stops before the event that would pass 4 MiB (`feed::PARSE_BUDGET`); the first
  event is always kept, so a call progresses past one larger payload. `octet_length` takes
  the size from the record header, so the window itself reads no payload. `more` is true
  when the budget cut the window. Test: `one_call_parses_a_bounded_number_of_payload_bytes`
  (three 3 MiB tool payloads, one per call, then the approval behind them).
- **Measured** (`measure_one_page_over_5000_large_events`, ignored; debug build, file
  database, 5,000 activity events of 100 KiB, about 500 MB): unbounded (before) 598 ms on
  the database worker for one page; bounded 31 ms reopened, 20 ms warm, scanning 40 events.
  The worst left is one event larger than the budget, parsed alone in its call, plus one
  small previous session update per session update in the window.

## X4 implementation notes (2026-10-31)

X4 was implemented on `claude/v0131-139-x4`, from the batch tip `8d400e20df` (slice 1, the CLI,
F0, wave 1, D, T, X2, X1 and their review fixes). It adds `mcp/tools/panels.rs` (four tools in
the Workspace set), `production/ui_intents_rpc.rs` (`ui.publishIntent` and
`subscribeUiIntents`), `packages/contracts/src/uiIntents.ts`, the client-runtime fold
(`state/uiIntents.ts`), `UiIntentNotifier.tsx`, `MessageProvenance.tsx`,
`PanelTabAgentBadge.tsx` and `mcp_tools_tests/panels.rs`. No migration.

**Who may set `sourceThreadId` (decided here, as X1 left it).** It is provenance a person
reads, so the server derives it rather than trusting a client:

- The engine accepts `message.sourceThreadId` on `thread.turn.start` only when the command's
  admission claim carries an `mcp-client` actor (`plan_command` takes
  `command_claim.actor().is_some()`), and only for another live thread of the target's
  worktree: the same host thread, or one hosts the other. Same project is no longer enough,
  and a thread cannot name itself. Anything else is an invariant (a rejected receipt), so
  nothing is projected. This replaces X1's same-project rule in `engine.rs`.
- A person's client therefore cannot claim a message came from a panel. MCP clients reach
  dispatch only through tools; only `send_panel_message` sets the field, after its own
  `McpNotSameWorktreeError` check, and `send_message` refuses the argument as unknown.
- Test: `a_source_thread_named_outside_a_panel_message_never_persists` (a person's forged
  value, an agent naming another worktree's thread, and an agent naming the target itself
  are each refused with no user message stored). It failed with X1's rule.
- A panel message queued behind a running turn is delivered by the server's turn delivery,
  which advances the outbox and never re-plans the `thread.turn.start`, so the actor check
  does not refuse it later (`a_panel_message_queued_behind_a_running_turn_is_delivered_once_it_settles`:
  the message leaves the queue, no receipt is rejected, and its source is kept).

**Drift and verified facts:**

- **`ui.publishIntent` needs an outside agent.** The design gives the intent a non-optional
  `actor` and a toast that says "Agent <label>", so the handler refuses any principal that
  is not `mcp-client` (`UiIntentError`, `reason: "actor"`). It repeats the shape checks
  (surface, a relative literal path for `files` and `diff` only); the full C5 check against
  the thread's folder runs in `focus_ui`, which has the thread's `cwd`.
- **The intent carries `kind` and `expiresAt`** beside the design's fields:
  `{ kind: "focus", intentId, threadId, surface, path, actor, createdAt, expiresAt }`. `kind`
  is the union tag X7 extends; `expiresAt` lets a client that connects late, or a hidden
  window shown again, offer a pending intent only for the time it has left.
- **The stream sends a snapshot.** `subscribeUiIntents` starts with the pending intents, then
  each new one; a stream that lags gets a fresh snapshot. Clients keep an intent once by id.
  The subscriber count `focus_ui` returns is the broadcast's receiver count, so it counts
  open streams (windows and environments connected), not people.
- **Errors.** The 17th pending intent of a thread is `UiIntentError` with `reason: "limit"`,
  passed through to the agent as that tag; a refused path or surface is
  `McpInvalidArgumentError` from the tool.
- **`create_chat_panel`** refuses a host that is itself a panel (`McpNotAHostThreadError`);
  any other live thread may host, as in the UI. Its title is "Panel — <instanceId>" unless
  set (the UI's is "Panel — <provider label>"). It stores `{ commandId, runtimeMode, payload }`
  through `ToolCall::commands`, as `create_worktree` does, so a retry replays by claim.
- **"Adopted by a second client"** is web behavior (`centerPanelAdoption.ts`, already
  tested there). The server test proves what adoption reads: the shell lists the panel once
  with `kind: "panel"`, its `hostThreadId` and the agent's `requester`.
- **`includeLastReply`** quotes the source's newest non-empty assistant message as Markdown
  (`> Last reply in “<title>”:`), at most 16,000 characters, then
  `> … (cut at 16000 of N characters)`. Text and quote must fit the 120,000-character turn
  limit together. The result's `quotedReply` says whether a reply was quoted.
- **`read_thread`** now returns each message's `sourceThreadId`.
- **Activity rows name no thread for two tools.** `McpControl::call_in` reads `threadId`
  only, so `send_panel_message` (`fromThreadId`, `toThreadId`) and `create_chat_panel`
  (`hostThreadId`) record a row with a null thread, and X3's feed sees none.
  `mcp/activity.rs` is being changed by the X1 review fixes this wave, so this is left as a
  follow-up (read `toThreadId` and `hostThreadId` too) rather than renaming the design's
  arguments. `focus_ui` takes `threadId` and records it.
- **Files touched beyond X4's rows:** `orchestration/engine.rs` (the rule above, at the
  coordinator's request); `mcp/tools/threads.rs` (`thread_summary` made `pub(crate)`, and
  `sourceThreadId` in `read_thread`); `production/runtime.rs` (X5's file this wave: the
  intents service registration, four lines); `production/mod.rs`;
  `mcp_tools_tests/worktrees.rs` (`worktree.createPanel` added to the forwarded methods);
  `AppRoot.tsx` and its two tests (one mount line); `CenterPanelTabs.tsx` and its test (the
  panel tab badge); `MessagesTimeline.tsx` (one import and one element, replacing X1's chip
  line with `MessageProvenance`, which renders the chip and the source).
- **Counts.** Methods 178 → 180, streams 28 → 29, stream shapes 88 → 90, typed failures
  371 → 373, fixtures 495 → 499, schema fingerprints 459 → 463 (exporter, its test and
  `tests/rpc_wire.rs`).

**UI choices:**

- **Toast.** `UiIntentNotifier` is mounted once outside the router, with one subscriber per
  environment through the atom registry (no React state, so an intent re-renders nothing).
  Copy: **Agent <label> wants to show** _a thread_, _files_ / _a file_, _Source Control_,
  _the diff_ / _a file's diff_, with the thread title (and path) as the description and one
  **Show** action. The toast's timeout is the intent's remaining time. An intent already
  announced is never raised again in that window, also across remounts.
- **Show** routes to the thread; for a chat panel it routes to the host and activates the
  panel's tab, and opens right-panel surfaces on the host (files with a path open that file;
  diff with a path selects it in Compare).
- **Provenance.** `MessageProvenance` shows **From <panel title>** (or "From another thread"
  when this client no longer has it) beside the **Agent · <label>** chip, as text.
- **Panel tab chip.** A chat panel tab whose thread has a `requester` shows a small **Agent**
  text badge (not a control, since it sits inside the tab's button; it has screen-reader text
  naming the agent), and the tab's tooltip adds "Opened by Agent · <label>" and the purpose.
  The tab bar has no environment, so the thread is found by id (`findThreadRef`); thread ids
  are unique across environments.

**Notes for X7** (adds `commitMessage` to `ui_intents_rpc.rs`):

- Add the kind to `UiIntent` in `packages/contracts/src/uiIntents.ts` (the union already has
  one member) and a `publish_commit_message` beside `publish_focus`, with its own retention
  (last per `cwd`, 24 hours) in the same `pending` list or a second one; `pending()` feeds the
  snapshot, so a panel opened later receives it.
- `ui.publishIntent`'s input is `{ threadId, surface, path? }` today; give it a `kind`
  discriminator (default `focus`) rather than a second method, or add
  `ui.publishCommitMessage` if a separate scope or shape reads better, and move the counts.
- `UiIntentNotifier` already skips any kind other than `focus`; the Source Control panel
  folds `uiIntentsEnvironment.intents` for its own kind.

**Codex review round 2 (2026-10-31).** Both P2s were verified and fixed test-first.

- **A panel message could speak as another agent's panel.** `send_panel_message` checked
  only that `fromThreadId` shares the target's worktree, so agent B could send its own text
  labelled "From <agent A's panel>". The tool now also requires that the calling agent owns
  the source: its session is the thread's `requester` (it opened it), or its actor sent the
  thread's latest user message (it drives it). Otherwise `McpSourceThreadNotOwnedError`, and
  nothing is stored. A person's thread, which has neither, is never an agent's source.
  `a_panel_message_comes_only_from_a_thread_the_calling_agent_opened_or_last_drove` failed
  before the check (B's message was stored) and covers A's own panel and a thread B drives.
  A `bibcode thread` run mints a credential per run, so a panel one run opened is not the
  next run's source until that run sends it a message.
- **Pending intents had no server-wide bound.** Beside 16 per thread, an agent credential
  may hold 64 pending intents (`UiIntentError`, `reason: "limit"`), and the server holds at
  most 256, dropping the oldest first. A subscriber's snapshot carries the newest 64 (the
  client keeps 64); one server is one environment, so the snapshot is already that
  environment's. Tests: `one_credential_holds_at_most_64_pending_intents_across_threads` and
  `the_server_holds_at_most_256_pending_intents_and_snapshots_the_newest_64`.
- **New error tag** `McpSourceThreadNotOwnedError`, beside X4's `McpNotSameWorktreeError` and
  `McpNotAHostThreadError`: X3's `feed::ERRORS` (not on this branch) must list all three
  when the branches combine.

## X6 (clone) implementation notes (2026-10-31)

X6 was implemented on `claude/v0131-139-x6`, from the batch tip `8d400e20df` (slice 1, the
CLI, F0, wave 1, D, T, X2, X1 and their review fixes). It adds `mcp/tools/clone.rs`
(`clone_repository`, `clone_status`, `cancel_clone` in the Workspace set),
`git/clone_policy.rs`, and `production/mcp_tools_tests/clone.rs`, and changes
`git/repository.rs`, `production/clone_operations.rs` and `production/git_vcs.rs`. One
registration line each went into `mcp/tools/mod.rs`, `control::FAMILIES`,
`mcp_tools_tests/mod.rs` and `git/mod.rs` (`pub(crate) mod clone_policy`). No contract,
migration, RPC method, scope or `latency.rs` entry changed.

**Revision 4 requirements:**

- **LFS smudge off.** Every agent clone runs with `GIT_LFS_SKIP_SMUDGE=1` and
  `-c filter.lfs.smudge= -c filter.lfs.process= -c filter.lfs.required=false`. Git treats an
  empty driver command as no filter, so LFS files stay pointer files and a global
  `filter.lfs.required=true` no longer fails the clone. The test
  (`lfs_smudge_never_contacts_the_lfsconfig_endpoint`, `cfg(unix)`) clones a repository with
  an LFS-tracked pointer and a `.lfsconfig` whose `lfs.url` names a counting local endpoint,
  under a test global configuration whose smudge filter, like `git-lfs`, reads that URL and
  contacts it with `curl`. It was seen failing (one connection) with the four settings
  removed.
- **HTTPS only.** SSH, `git+ssh://`, the scp-like `host:path`, `git://`, `file://`, a bare
  path, `ext::`, `<transport>::` and `http://` are refused as `clone_url_refused` with "over
  HTTPS only" before Git or DNS run. The unit test checks each transport is refused for
  being one: the first version passed with `ssh://` allowed, because its cases carried a
  user and the credentials rule refused them first; the cases now include user-less SSH
  URLs, and the test and the integration test were seen failing with `ssh://` admitted.
  **Follow-up: pinned SSH.** SSH resolves the host again after any check, so an agent SSH
  clone needs a pinned connection (for example `ssh -o HostKeyAlias=<host>` to the checked
  address through `core.sshCommand`, with `ProxyCommand`, `ProxyJump` and a replaced `ssh`
  refused as the design's SSH section says) before it can be allowed.

**Drift found:**

- **`project.create` does not refuse a registered root.** The design cites `engine.rs:3958`;
  that check is `project.meta-update`'s. For `project.create`, `process_envelope` answers a
  workspace root that a live project already has with that project's id (an accepted
  receipt, `DispatchResult.projectId`). Registration reads `projectId` from the dispatch
  result, and `created` says whether it is the frozen id.
- **A refusal needs no new contract shape.** `vcs.clone` declares `GitCommandError` and
  `GitCloneOperationError` (whose reasons are a closed set), so a policy refusal is a
  `GitCommandError` with an extra `reason` (`clone_url_refused`, `clone_host_refused`,
  `clone_host_unresolved`, `clone_git_too_old`, `clone_destination_refused`); the schema
  ignores the extra field. `sourceControl.cloneRepository` carries the same `reason` on its
  `SourceControlRepositoryError`. The design's SSH bullets are superseded by Revision 4.
- **The destination rule holds at the RPC too.** "Destination inside the allowed root" is by
  construction for the tool, but an agent can call `vcs.clone` with any `parentDir`. For an
  `mcp-client` principal, both handlers require the canonical parent to be the folder that
  holds a live project (`clone_destination_refused`), using `GitVcsRpcServices`'
  `repositories` (present in production; without it every agent clone is refused).
  `sourceControl.cloneRepository` no longer creates the parent folder for an agent before
  that check.
- **`clone_status` reads by replay, not SQL alone.** A `running` row is live only while this
  process holds its claim, which only `outcome.rs` sees (X5's file this wave). The tool
  stores the arguments it keyed `recorded` with, and `clone_status` replays them through
  `recorded` with an already-cancelled wait: a held claim answers `running`, a settled row
  its outcome, an unowned `running` row `McpOutcomeUnknownError` (`restarted`). The row
  exists, so the replay never runs work. Rows are per session, so after `bibcode mcp`
  restarts (a new credential) the old `cloneId` is `McpCloneNotFoundError`; the old
  session's revocation has stopped that clone anyway.
- **`cancel_clone` needs its own token.** The live controls' token fires only on their four
  sources. The task's stop token is a child of it, kept in a process-wide map by session and
  `cloneId` (`McpControl` has no slot, and `control.rs` is not X6's). The task races
  `vcs.clone` against it and drops the call at once, rather than waiting out `run`'s 10 s
  grace. A live control replaces the work's unknown answer with its own reason;
  `cancel_clone`'s keeps `reason: "cancelled"` and a clone-specific message.
- **The activity row says `success` for a running clone.** X1's `settle` polls only after
  `McpCancelledError`, and `clone_repository` answers a clone past its wait as
  `{ state: "running", cloneId }`, so the row records the call's answer with the `cloneId`
  target; the clone's final outcome is `clone_status`. Follow-up: an activity row per
  settled clone.
- **Joining shares the starter's Git.** The plan rides on the `CloneRequest`, so an agent
  whose check passed and that joins a person's running clone of the same URL waits on that
  unpinned clone; a person who joins an agent's clone shares its pinned one. A refused agent
  never reaches admission, so it cannot join anything.
- **Redirects.** With `http.followRedirects=false`, curl's 3xx reaches Git as
  "returned error: 30x"; the transfer appends "BiBCode does not follow redirects for an
  agent. Clone the address it moved to." to that detail.

**Choices made while implementing:**

- **The URL must be written as the parser writes it** (case aside): no percent-encoding,
  unicode or numeric IPv4 host, default port, trailing dot or whitespace. Then the host the
  policy resolves and pins is exactly the host curl uses (curl lowercases host cache ids,
  so the parser's lowercase host matches). Both the original and the `insteadOf`-rewritten
  host are checked and pinned, so a rewrite that only `ls-remote` or only `clone` applied
  still meets a pinned, public host. Every resolved address must be public, and the first
  is pinned (`host:port:a`, IPv6 in brackets): curl before 7.59 skips a comma-separated
  list it cannot parse and would resolve the name again. An IP-literal host needs no pin.
- **`submodule.recurse=false`** is set too, so no submodule host the policy did not check
  is contacted, whatever the person's configuration says.
- **`GIT_ALLOW_PROTOCOL=https`** is set beside `protocol.allow=never`, since Git lets the
  variable override the configuration.
- **Addresses** are checked by hand (CGNAT, unique-local and the IPv4-compatible `::/96` are
  not stable `std` methods): loopback, private, link-local, CGNAT, `0/8`, multicast,
  broadcast, `240/4`, `fc00::/7`, `fe80::/10`, `fec0::/10`, and mapped or compatible forms.
- **Git version.** `http.curloptResolve` is in Git 2.37.0's release notes (checked in the
  installed `RelNotes/2.37.0.adoc`); an older or unreadable version is `clone_git_too_old`.
- **The tool does not pre-check the URL.** A refusal comes from `vcs.clone` and is the
  recorded `failed` outcome, so the fixture policy (below) reaches the tool path too.
- **Results.** Done: `{ state: "done", cloneId, path, project: { projectId, created,
  defaultThreadId } | null }`. The default title is the folder name.
- **Tests without the network.** `ClonePolicy` takes a `HostResolver`; tests use a map.
  `FixtureAllowance` (test only) adds environment (a test `GIT_CONFIG_GLOBAL`) to every Git
  command the policy runs and, with `admit_local`, admits `http://` and loopback, so a
  dumb-HTTP fixture at `http://fixture.invalid:<port>/repo.git` stands in for a public HTTPS
  host. `.invalid` resolves only through the map, so a clone that reaches the fixture went
  through the pinned address. The strict tests (`admit_local: false`) use the same
  environment for `insteadOf` rewrites. `clone_repository`'s 50 s wait is shortened per
  test through a task-local.

**Tests:** `git::clone_policy::tests` (URL shapes, option-like folder names, the address
list, the plan's settings and pin, refused and unresolved hosts, the fixture allowance) and
`production::mcp_tools_tests::clone`: a clone beside the project through the pinned address
that registers it; a keyed retry that replays, and later requests that reuse the finished
clone without contacting the server and find or create one project; a destination holding
other files refused and left alone; a redirect not followed; LFS; refused transports, hosts
and rewrites through the tool, refusals on `vcs.clone` and `sourceControl.cloneRepository`
called directly (and outside the projects folder), and a person's `file://` clone outside it
still working; a clone past the wait that answers `running` and later its project;
`cancel_clone`, revocation and the off switch each stopping the agent's clone and removing
its folder; and cancelling an agent clone that joined a person's leaving the person's to
finish. Take over and Stop reach the same live-controls token (X1) and are not tested again
here.
