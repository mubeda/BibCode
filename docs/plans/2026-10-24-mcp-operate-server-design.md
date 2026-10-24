# MCP Server for Outside Agents

Status: Approved 2026-10-24 with every recommended answer. Issue #139. Implemented last in
the batch after v0.11.0.

## Goal

Let an agent harness that BiBCode did not start, such as Claude Code or Codex
in a terminal, operate a BiBCode environment through MCP. It should be able to
list projects and threads, start a thread on a chosen provider and model, send
messages, wait for turns, answer questions, interrupt, and read diffs, both
locally and on an SSH host.

Today BiBCode can only be driven from its UI. A terminal agent cannot hand work
to a BiBCode thread on another provider, wait for it, and collect the result.

## Current behavior (verified at 4e023ac5ff)

- **Profiler MCP.** `bibcode profiler mcp` is a hand-rolled, read-only stdio
  server (`apps/server/src/diagnostics/profiler/mcp.rs:1-7`). It speaks
  2026-07-28 and 2025-11-25/2025-06-18 (`:24-26`), detects a modern request by
  `_meta["io.modelcontextprotocol/protocolVersion"]` (`:28`), answers
  `server/discover`, returns `-32022` for an unsupported version, adds
  `resultType` only to modern results, and caps results at 80,000 characters
  with `truncated` (`:437`). It serves one request at a time (`:55`). Its
  authentication is filesystem permissions (`docs/architecture/overview.md:1924-1934`).
- **Desktop entry.** The desktop executable runs `profiler` before Tauri and
  after `crash::attach()` (`apps/desktop/src-tauri/src/main.rs:3-28`,
  `apps/server/src/diagnostics/profiler/cli.rs:136-162`). Nothing else is
  dispatched there.
- **`POST /mcp`** (`apps/server/src/production/http_routes.rs:336`,
  `:776-793`) goes straight to `ConnectMcpService::mcp`. Unlike `json_request`,
  it never calls the route authorizer and never checks `Origin`. It serves
  only `preview_*` and `device_*` (`connect_mcp.rs:1642-1698`). It accepts only
  the random bearers that `issue_mcp_credential` (`connect_mcp.rs:412-460`)
  mints when a provider is launched (`provider_runtime.rs:1210`). These are kept
  in memory, with a 30 min idle limit and an 8 h lifetime (`connect_mcp.rs:34-35`).
  It speaks only the legacy session shape, and `initialize` echoes whatever
  `protocolVersion` the client sends (`connect_mcp.rs:1010`). Session records
  are in memory too, so after a restart a request with an old
  `Mcp-Session-Id` gets 404 (`connect_mcp.rs:988-993`). There is no
  per-call scope check, by invariant (`connect_mcp.rs:1079`,
  `docs/architecture/remote.md:1651-1655`). There is no `RequestTimer` on the
  path. Responses are buffered `Vec<u8>` bodies, so there is no SSE.
- **RPC.** Scope is per method (`apps/server/src/auth/scope.rs:11`).
  `orchestration.dispatchCommand` needs `orchestration:operate` for every
  command type (`scope.rs:108`), including `thread.delete`. Admission
  (`admit_request`: scope, then the maintenance gate) is in
  `apps/server/src/rpc/session.rs:1173-1229`. Timing is wrapped around every
  unary handler at registration (`session.rs:554-594`). Handlers can be reached
  only through a WebSocket session: `RpcRegistry::get` is private
  (`session.rs:637`).
- **Durable ingress.** The `dispatchCommand` handler sends `thread.turn.start`
  through command admission, workspace admission and durable provider delivery
  (`apps/server/src/production/orchestration_rpc.rs:131-188`; the turn branch
  is `:149-175`). `POST /api/orchestration/dispatch` refuses it
  (`apps/server/src/production/runtime.rs:715-719`). The digest covers the
  whole public payload, `createdAt` included
  (`apps/server/src/orchestration/delivery.rs:115`), so only a byte-for-byte
  identical retry can replay.
- **Command receipts.** A receipt is `reserved`, `prepared`, `accepted` or
  rejected, and every check compares the full digest and the aggregate
  (`apps/server/src/orchestration/engine.rs:2060-2133`). A retry of an
  `accepted` command replays its result, a rejected one returns
  `PreviouslyRejected`, and a matching `reserved` receipt left by a crash
  before enqueue is resumed, not reported as done
  (`apps/server/src/persistence/repositories.rs:597-630`). A different
  payload under the same ID gets `command-conflict`. Concurrent dispatches of
  one ID wait for the same in-process claim (`engine.rs:1913-1922`).
- **Turns and replies.** A queued or pending turn row records the user
  message as `pending_message_id`, and the settled row records
  `assistant_message_id` (`engine.rs:39`, `:6174`;
  `repositories.rs:2432-2447`). Messages carry their `turn_id`
  (`repositories.rs:2351-2368`).
- **Thread reads.** The `subscribeThread` snapshot loads every message and
  activity of the thread before anything is truncated (`engine.rs:7152-7160`).
  Messages have a `(thread_id, created_at, message_id)` index
  (`apps/server/src/persistence/migrations.rs:1909-1910`).
- **Answers.** `thread.user-input.respond` reaches the provider driver
  directly and the turn continues in the thread's current runtime mode
  (`apps/server/src/production/provider_runtime.rs:7678-7681`).
- **Thread state.** `OrchestrationThreadShell` has session status, latest turn,
  `hasPendingApprovals`, `hasPendingUserInput` and `unresolvedDelivery`
  (`packages/contracts/src/orchestration.ts:555-595`). These are built from
  `projection_threads` counts (`orchestration_rpc.rs:1806-1826`). Live updates
  come from `engine.subscribe_events()` (`apps/server/src/orchestration/engine.rs:2674`).
  Streams subscribe before they read (`orchestration_rpc.rs:922-959`,
  `:1169-1201`).
- **Runtime modes.** `DEFAULT_RUNTIME_MODE` is `full-access`
  (`orchestration.ts:119-125`). The UI labels the modes Supervised,
  Auto-accept edits and Full access
  (`apps/web/src/components/chat/ChatComposer.tsx:142-154`).
- **Auth.**
  - `bibcode pairing issue` writes a five-minute pairing link into the data
    root's database while the server runs (`apps/server/src/lib.rs:309-347`).
    The link has administrative scopes (`apps/server/src/auth/service.rs:2709-2745`).
  - `/oauth/token` narrows scopes on exchange (`service.rs:839-856`). Every
    session lasts 30 days (`service.rs:40`).
  - The `desktop-managed-local` policy advertises only `desktop-bootstrap`
    (`service.rs:465-477`), but neither `consume_grant` (`service.rs:2199-2249`)
    nor `token_inner` (`auth/http.rs:139-208`) checks the policy. A data-root
    pairing link is therefore accepted by a desktop's in-process server today.
  - Revoking a client needs `access:write` (`auth/http.rs:571-580`). Writing
    `revoked_at` through the data root (`persistence/repositories.rs:2014`)
    takes effect on the next request, because every bearer authentication
    re-reads the session row (`service.rs:1049-1070`).
  - Session tokens are `payload.signature`, and the base64url JSON payload
    carries `sid` and `sub` (`apps/server/src/auth/token.rs:31-39`,
    `:73-85`).
- **Discovery.** `StatePaths` declares `server-runtime.json`
  (`apps/server/src/persistence/state_files.rs:82`), but nothing reads or
  writes it. The desktop takes the first free port from 3773
  (`apps/desktop/src-tauri/src/backend.rs:46`, `:3134-3141`) and tells only its
  renderer. The server already does owner-only work under `StoreRuntimeGuard`
  before it binds (`apps/server/src/lifecycle.rs:232-251`). Its `bootId` and
  `storageInstanceId` are public in the environment descriptor
  (`apps/server/src/http.rs:490-530`), so neither can prove who is listening.
- **Launch context.** The state directory is `dev` when `--dev-url` is set
  and `userdata` otherwise (`apps/server/src/config.rs:206-212`), and the data
  root comes from `--base-dir`, `BIBCODE_HOME` or the desktop bootstrap
  (`config.rs:1083-1090`). A WSL server runs as
  `wsl.exe -d <distro> --exec env PATH=… <binary> serve` with its own data
  root, bound to `0.0.0.0` inside the distribution
  (`apps/desktop/src-tauri/src/backend.rs:69`, `:237-269`). The desktop
  already knows each WSL distribution and SSH target
  (`packages/contracts/src/ipc.ts:327`, `:581-587`).
- **Settings.** Live switches are `watch` signals in `NativeServerControl`,
  such as `device_previews_enabled_signal` (`production/control.rs:484-492`).
  They are backed by `ServerSettings`/`ServerSettingsPatch`
  (`packages/contracts/src/settings.ts:490-497`, `:658-664`).
- **Shutdown.** `quiesce_for_update` stops services in order and calls
  `profiler.end_session()` last (`runtime.rs:808-861`).
- **CLI.** `docs/user/remote-access.md:171` says the CLI "has no `project`
  subcommand". There is no `bibcode mcp` and no `bibcode thread`.

## Goals and non-goals

Goals:

- First-slice tools: `list_projects_and_threads`, `list_providers_and_models`,
  `start_thread`, `send_message`, `wait_for_thread`, `read_thread`,
  `list_pending_requests`, `answer_question`, `interrupt_turn`,
  `get_turn_diff`, `git_status`.
- These tools over stdio through `bibcode mcp`, through `<desktop exe> mcp`,
  and through `ssh <host> bibcode mcp`.
- A narrowed, labelled, revocable credential that is never printed, with an
  access ceiling bound to it.
- An `enableMcpServer` setting, on by default and enforced per environment.
- Bounded waits tied to one turn, which send progress notifications and
  release their subscriptions.
- Size-capped, paginated results marked untrusted.
- One shared MCP protocol module.
- Living docs, and a skill built test-first.

Non-goals for slice 1:

- Remote Streamable HTTP for outside agents, which needs MCP OAuth (see
  Answers to the open questions).
- Messages outside a request, such as a standalone `GET /mcp` stream.
  Progress travels only on the response to the `tools/call` it reports on.
- Worktrees, Git write operations, pull requests, terminals and device previews.
- The Tasks extension and resources.
- Answering approvals.
- Attachments.
- Destructive operations (worktree removal, discard, undo, revert, delete,
  force-push), settings, credentials, the updater, pairing, relay, and CLI
  session import.
- `bibcode thread`, which is designed here and ships next (see CLI front end).

## Alternatives

**A. Stdio RPC client.** `bibcode mcp` would speak the WebSocket RPC. That
reuses every server check, but BiBCode has no production Rust RPC client, the
credential would reach every RPC method (`thread.delete`, `gitManager.discard`),
and remote HTTP would still need a second surface. Rejected.

**B. Server-hosted tools on `/mcp`.** Tools run in the server and dispatch
through the RPC handlers, so they share scope checks, admission, receipt replay
and timing. Stdio clients still need a bridge. There are two ways to reach the
handlers:

- **B1.** Add a `pub(crate)` local-invocation entry on `RpcRegistry`. It runs
  `required_scope(tag)`, `authorize_session`, `admit_named`, and then the
  registered handler, so the `thread.turn.start` branch and the timing wrapper
  are reused unchanged. The cost is an `RpcSessionContext` built for a
  principal that has no socket.
- **B2.** Extract a thread-operations service that the RPC closure and the
  tools both call, as the upstream project's orchestrator design does. This is
  cleaner, but it moves the turn branch, workspace admission and delivery out
  of `orchestration_rpc.rs` before anything needs a second policy there.

**C. B, plus a stdio-to-HTTP relay.** `bibcode mcp` forwards each stdio message
to the local server's `/mcp`, with a credential it mints from the data root.
One implementation serves both transports, and SSH works like the profiler.

**D. The CLI opens the store itself.** Rejected. The orchestration engine is
the single owner of the store, and command claims are process-local
(`docs/architecture/rpc-and-orchestration.md:1431-1442`).

Remote HTTP choices:

- **R1.** MCP OAuth: Protected Resource Metadata (RFC 9728), an authorization
  endpoint whose consent page takes a pairing code, PKCE, and Client ID
  Metadata Documents.
- **R2.** A static bearer passed with `--header`. It is not spec-conformant,
  and it parks a 30-day operate token in the harness config.

Path choices: one `/mcp` for provider and client credentials, or a separate
path for each.

## Decision

**C with B1, stdio only in slice 1.** Remote HTTP is deferred to R1, and both
credential kinds share `/mcp`.

- B1 is the smallest change that reuses the durable ingress exactly as the UI
  uses it.
- B2 becomes worth doing when a second consumer needs policy that the RPC
  closure lacks; the tool layer keeps its own policy (the runtime-mode
  ceiling).
- One path means one resource identifier for the later OAuth slice, and the
  per-call scope checks become real code instead of an invariant.

What this trades away:

- Agents on another machine reach the server only through SSH until R1 ships.
- One wait call lasts at most 50 s, under Codex's 60 s default tool timeout.
  A longer wait is a loop of calls (see Waiting).
- Retries with a `clientRequestId` need one small table, so this slice has a
  migration.
- An agent cannot approve anything. A Supervised thread stops at its first
  approval until a person answers it in BiBCode.

## Design

### Protocol module

`apps/server/src/mcp/protocol.rs` takes over the framing in profiler
`mcp.rs`:

- version negotiation and `server/discover`;
- legacy `initialize`, accepting only the supported versions and otherwise
  answering 2025-11-25;
- `resultType`, `ttlMs`/`cacheScope` on lists, and the error codes;
- `tool_result` with `Cut` truncation, bounded messages, and the descriptor
  helper that adds the untrusted sentence and
  `_meta["anthropic/maxResultSizeChars"] = 80000`.

The profiler's stdio loop and the `/mcp` HTTP adapter both call it, and the
profiler's behavior does not change. Its tests keep their `exchange_bytes`
shape. No third copy exists.

### `/mcp` endpoint

- **Origin.** A request whose `Origin` is present and is not this server's
  own origin gets 403, as the 2026-07-28 transport requires. No browser
  surface uses `/mcp`. Before this lands, a launch smoke test of every
  provider confirms that their MCP clients send no other `Origin`.
- **Eras.**
  - A modern request must carry `MCP-Protocol-Version`, `Mcp-Method` and, for
    `tools/call`, `Mcp-Name`, all matching the body. A missing or mismatched
    header gets 400 with `-32020`. An unknown method gets 404 with `-32601`.
  - A legacy provider keeps `initialize` and `Mcp-Session-Id`, because
    providers already launched use them.
  - A legacy client principal gets no `Mcp-Session-Id`, which the legacy
    transport allows. Its later requests carry the negotiated
    `MCP-Protocol-Version` header instead. The bearer, which is a durable
    session row, already identifies the caller, so the server keeps no
    per-connection state that a restart or an off/on cycle could lose.
  - Responses are `application/json`, except a `wait_for_thread` call whose
    request carries `_meta.progressToken`, which gets `text/event-stream`
    (see Waiting).
- **Principals.** A bearer resolves to one of two kinds, and any other session
  token gets 401:
  - a provider credential (the random token in `McpState`), carrying its
    `PreviewScope`;
  - an MCP client session (a signed session token whose session subject is
    `mcp-client`), carrying its access ceiling.
- **Endpoint proof.** `POST /mcp/endpoint-proof` is unauthenticated and
  accepts only loopback peers. It takes a 32-byte relay nonce and returns
  `HMAC-SHA256(proofKey, "bibcode-mcp-endpoint-v1" ‖ nonce ‖ local port)`.
  `proofKey` is random per boot and exists only in server memory and the
  owner-only endpoint record. The peer check and the local port both come
  from the connection's `ConnectionAddrs` (`apps/server/src/http.rs:142-154`),
  so a listener that forwards the nonce to the real server on another port
  gets a proof that does not verify.
- **Tool registration.** Each tool is registered with its principal kinds, its
  required scope (from `required_scope` of the RPC method it maps to), whether
  it is long-running, and its handler. Registration is the only way to add a
  tool, and the call path checks the scope before the handler runs.
  - `preview_*`/`device_*` are provider-only and require
    `orchestration:operate`. Provider credentials hold
    `orchestration:read orchestration:operate` implicitly.
  - Thread tools are client-only.
  - `tools/list` returns the caller's tools with `cacheScope: "private"`.

### Credential

The relay mints its credential with a new dedicated issuer,
`issue_mcp_pairing_link`. The link has scopes
`orchestration:read orchestration:operate`, subject `mcp-client`, the label
`MCP · <client name>`, an access ceiling, and a 60 s TTL. Because it never
holds administrative scopes, a stolen bootstrap cannot be widened at exchange.

**Access ceiling.** The ceiling is one of the four runtime levels (see
Tools). It is the environment's `mcpServerAccess` at mint time, or the lower
level that `bibcode mcp --access <level>` asks for; asking for a higher one
exits 1 with a message naming the setting. A new nullable `mcp_access` column
on `auth_pairing_links` and `auth_sessions` stores it, and the exchange copies
it into the session. The later OAuth slice writes the level chosen on its
consent page into the same column. Every call uses the lower of the
credential's ceiling and the current `mcpServerAccess`. Lowering the setting
therefore applies at once to connected agents, and raising it reaches an
agent only after its MCP server restarts and mints again.

The relay exchanges the link at `POST /oauth/token` over loopback. It reads
`sid` from its own token's payload, and records
`<state dir>/mcp-clients/<sid>.json` holding `{ pid, processStartedAt }`, with
no secret.

On stdin EOF, SIGINT, SIGTERM, or a Windows console close, it reopens the data
root and revokes `sid`. At start, it revokes and deletes records whose process
is gone. The token exists only in the relay's memory, so an orphan left by a
crash is clutter in Authorized clients, not an exposure.

Audience binding is what makes omission a real control. An `mcp-client`
session authenticates `/mcp` only. HTTP bearer and cookie routes, WebSocket
tickets, E2EE and `/api/orchestration/dispatch` refuse it, the way open-url
tokens are route-bound. The audience rule needs no new column, because
`subject` is already persisted; only the ceiling does.

### Discovery and launch

- **Endpoint record.** The server writes `server-runtime.json` (mode 0600)
  after `bind_listener`, under the `StoreRuntimeGuard` owner, and removes it at
  shutdown. It holds `{ version, pid, dialHost, port, bootId, startedAt,
  proofKey }`, and is written in the `userdata` or `dev` state directory the
  server uses. `dialHost` is a loopback address that reaches the listener:
  `127.0.0.1` or `::1` for a wildcard or loopback bind, and `null` when the
  server listens only on other interfaces. The desktop's in-process server
  writes it the same way.
- **Relay start.** `bibcode mcp [--base-dir] [--dev-url] [--url] [--access]`
  resolves the data root and state directory as `pairing issue` does. Then,
  within Codex's 10 s default startup timeout, it:
  1. reads `settings.json`, and exits 1 with "The MCP server is turned off for
     this environment. Turn on Settings → Agents → MCP server." when
     `enableMcpServer` is `false`;
  2. reads the record and checks that its pid is alive. A `null` `dialHost`
     exits 1 with "This BiBCode server does not listen on this computer's
     loopback address." `--url` replaces the record's address but not its
     `proofKey`, and in slice 1 it must name a loopback host (`127.0.0.1`,
     `::1` or `localhost`);
  3. proves the listener: it sends a fresh nonce to `/mcp/endpoint-proof` and
     compares the answer with the HMAC it computes from the record's
     `proofKey`, in constant time. On a mismatch, a refused connection or a
     missing route, it exits 1 with "The program listening on <address> is not
     this BiBCode server." No credential exists yet at this step, and none is
     sent;
  4. sweeps orphans, mints, and serves.
- **Desktop.** `<desktop exe> mcp` is dispatched in `main.rs` next to
  `profiler`, after `crash::attach()`. It uses the desktop's data root
  (`BIBCODE_HOME` or `~/.bibcode`). It does not attach the parent console when
  its standard handles are pipes, because stdout must carry only JSON-RPC.
- **SSH.** `ssh <host> bibcode mcp` reaches the host's loopback server with no
  tunnel.
- **WSL.** `wsl.exe -d <distro> --exec <binary> mcp --base-dir <root>`, the
  same distribution, binary and root the desktop launches the server with.
- **Launch command.** The server reports `mcpLaunch.argv`: its own executable
  (`std::env::current_exe`), `mcp`, `--base-dir <effective data root>`, and
  `--dev-url <url>` when it uses the `dev` state. The desktop knows the
  wrapper, so the UI prefixes `wsl.exe -d <distro> --exec` for a WSL
  environment and `ssh [-p <port>] [<user>@]<alias> --` for a managed SSH
  environment. A shared helper quotes each argument for the shell that runs
  the copied command: POSIX quoting on macOS and Linux and inside the remote
  part of an SSH command, Windows rules on Windows. No part of the command is
  guessed.

### Relay

The relay is a Tokio stdio loop. It reads each line (at most 4 MiB, as the
profiler does) and POSTs the body unchanged to `/mcp`. It adds
`Authorization`, `Accept: application/json, text/event-stream`, and, for
modern messages, `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name`. For a
legacy client it remembers the version that `initialize` negotiated and sends
it as `MCP-Protocol-Version` on every later request. It never sends
`Mcp-Session-Id`, because client principals have no HTTP session.

- **Concurrency.** Requests run concurrently, and one writer task serializes
  stdout lines. A wait therefore never blocks a list.
- **Responses.** It handles both response content types, writing each SSE
  `data:` message as a line.
- **Cancellation.** A stdio `notifications/cancelled` drops that request's
  HTTP body. On HTTP, closing the stream is the cancellation.
- **Server restart.** On a connection error it re-reads the record once and
  repeats the endpoint proof, so it survives a restart that moved the port.
  The bearer is a durable session row and no HTTP session exists, so the
  harness's next call works with no reinitialization. The same holds after
  the setting is turned off and on again.
- **401.** It never re-mints on 401, because the user may have revoked the
  client. It answers with a tool error: "BiBCode ended this MCP connection's
  access. Restart the MCP server in your agent to sign in again."
- **No server, or an older one.** An older server writes no record. With no
  live record, or a record whose `version` predates this feature, the relay
  exits 1 with "No BiBCode server with MCP support is running on this data
  root. Start or update BiBCode."

### Tools

Every tool takes ids, never paths or commands. The server resolves a thread's
working directory.

Results are bounded at 80,000 characters with `truncated: true` and an opaque
`nextCursor`. Each result says that thread content is untrusted output from
agents and tools.

**Retries.** Mutating tools take an optional `clientRequestId`. The tool layer
keeps no replay logic of its own. It stores the first commands it built and
lets the existing command admission replay them:

- **Without `clientRequestId`**, every call builds fresh UUID v4 ids (the
  workspace `uuid` already has the `v4` feature) and is a new request.
- **With it**, the first call builds the public commands with fresh ids and a
  frozen `createdAt`. In one SQLite job it then runs `INSERT OR IGNORE` into a
  new `mcp_tool_requests` table and reads the row back, the way
  `reserve_command_receipt` does. The row is keyed by
  `(session_id, client_request_id)` and holds the tool name, the canonical
  digest of the complete tool arguments as the agent sent them, the command
  payloads, and the creation time.
- **Every call with that key** compares the tool name and the argument digest
  with the stored row. Any difference, such as the same text with another
  model, provider or mode, returns `idempotency_conflict`. Otherwise it
  dispatches the stored payloads verbatim through B1. Their digests therefore
  match, and `dispatch_turn_command` replays by receipt state: `accepted`
  returns the original result, a crash's `reserved` receipt resumes delivery,
  and a rejection returns the original error. The result never reports a turn
  that was not admitted.
- **Concurrent first calls** both reach the `INSERT OR IGNORE`, only one row
  survives, and both dispatch the same stored commands, which the in-process
  command claim serializes.
- **Steering** stores two commands with separate ids: the queued
  `thread.turn.start` and the `thread.turn.steer` that names its `messageId`.
  A retry re-dispatches both. The start replays by its receipt. The steer
  replays its result, or, if its earlier attempt was refused and its
  reservation released, is tried again. The message is enqueued either way,
  so the worst case is the same fallback to queued.
- **Scope.** Rows belong to one client session, which is one running MCP
  server in the agent. Rows older than 24 h are deleted on insert, and a
  reused key after that is a new request whose ids differ. The
  `clientRequestId` description says this.

Defaults that come from the environment, such as the project's default model,
are resolved when the first call builds the commands. A retry after the
default changes still replays the original choice.

Each tool below names what it maps to and the scope it needs.

- **`list_projects_and_threads`** (the `subscribeShell` builder; read).
  Projects and threads with a derived `status` (idle, running,
  awaiting_approval, awaiting_input, delivery_failed, error, interrupted),
  pending flags, latest turn, provider and model. Inputs: `projectId`,
  `includeArchived` (false), `limit` (50, at most 200), `cursor`. The shell
  builder reads every thread's row and preview before `limit` applies. That
  is the same work a UI connect does, and it grows with the thread count, not
  with history, so slice 1 keeps it.
- **`list_providers_and_models`** (`server.getProviderCapabilities`; read).
  Instances with availability and models. Each provider lists its favorite,
  custom and default models plus at most 8 more, with `omittedModels` and a
  `search` input, because some catalogs hold hundreds.
- **`start_thread`** (`thread.turn.start` with `bootstrap.createThread`;
  operate). Takes `projectId` and `prompt`, and optionally `title`,
  `providerInstanceId`, `model`, `runtimeMode` and `interactionMode`. The
  default model is the project's `defaultModelSelection`, else the Default
  Agent's instance with its session-default model. Runs in the project folder,
  and returns the ids and the effective mode.
- **`send_message`** (`thread.turn.start` with `queued: true`, then
  `thread.turn.steer` for `mode: "steer"`; operate). Never interrupts. Steering
  falls back to queued, and the result says why. Refused when the thread's
  mode is above the access ceiling. Returns `threadId`, `messageId` and
  `queued`.
- **`wait_for_thread`** (engine events; read). See Waiting.
- **`read_thread`** (a new bounded page read; read). It does not use the
  `subscribeThread` builder, which loads the whole history. One SQLite job
  reads the thread row, the session, the pending flags, and at most `limit`
  messages (20 by default, at most 100) after a `(created_at, message_id)`
  keyset cursor on the existing index, with `LIMIT` in SQL. Queued messages
  come in their own list, capped at 20 with a count. Each message returns at
  most 16,000 characters through SQL `substr`, plus its full length.
  `read_thread { threadId, messageId, textOffset }` reads the next slice of a
  truncated message, so nothing is out of reach.
- **`list_pending_requests`** (the thread's pending approval and question
  rows, read directly rather than through the snapshot; read). Questions with
  their options. Approvals are listed read-only (kind and summary) and marked
  "answer in BiBCode".
- **`answer_question`** (`thread.user-input.respond`; operate). Refuses an
  approval request id. An answer resumes the provider, so it is refused when
  the thread's mode is above the access ceiling, as `send_message` is.
- **`interrupt_turn`** (`thread.turn.interrupt`; operate). Optional `turnId`.
  Idempotent. It stops work instead of advancing it, so the thread's mode is
  not checked.
- **`get_turn_diff`** (`orchestration.getTurnDiff`; read). `turnCount`,
  defaulting to the latest. Files come first. When the patch is truncated,
  `nextCursor` names the file index and character offset to resume from, so
  every patch line can be read. Each page computes the diff once, the same
  work as opening it in the UI.
- **`git_status`** (`vcs.refreshStatus` on the thread's directory; read).
  Branch, ahead/behind, and changed files.

**Access ceiling.** A new setting, `mcpServerAccess`, takes `read-only`,
`approval-required` (the default), `auto-accept-edits` or `full-access`. It
caps the whole environment, and each credential also carries its own ceiling
(see Credential). Every call uses the lower of the two.

- `read-only` hides the operate tools and refuses them.
- `start_thread` with no `runtimeMode` runs at the session default capped at
  the ceiling, and reports the effective mode.
- An explicit mode above the ceiling is refused with a message naming the
  setting.
- `send_message` and `answer_question` on a thread whose mode is above the
  ceiling are refused. Both advance work. A credential limited to Supervised
  must not drive a Full access thread, and silently lowering a person's
  thread would surprise them.

### Waiting

`wait_for_thread` takes `{ threadId, messageId?, timeoutMs }`. `timeoutMs`
defaults to 30,000 ms. A larger value is clamped to 50,000 ms, and the result
reports `effectiveTimeoutMs`.

**Which turn.** With `messageId`, the wait follows the turn that message
started. It is the `projection_turns` row whose `pending_message_id` is the
message, or the message's own `turn_id` once the turn runs. A message still
queued, or not yet admitted, reports `queued` from its delivery row. Without
`messageId`, the wait follows the whole thread until it is idle, and reports
the newest turn at that moment. The result always names the `turnId` whose
state and reply it returns.

1. It subscribes to `subscribe_events()` before its first read.
2. It reads one targeted wait state in a single SQLite job: the
   `projection_threads` row, the session, the selected turn row, and, when
   `messageId` is given, that message's delivery.
3. It keeps only events whose `aggregate_id` is the thread. Each matching
   event, or a `Lagged` error, schedules one re-read 100 ms later.

It returns on the first of these:

- the selected turn settles, or, without `messageId`, the thread is not
  running and has no promotable queued message;
- `awaiting_approval`;
- `awaiting_input`;
- `delivery_failed`;
- an error;
- the timeout, which returns `timedOut: true` and the latest state, and never
  cancels work.

The result carries the selected turn's state and the text of its
`assistant_message_id`, capped, never the thread's newest reply. A second
wait on an older message after a newer turn completed therefore returns the
older turn's reply. Returning, timing out, cancellation, or the setting
turning off drops the receiver; #113 is the regression this guards.

**Progress.** When the `tools/call` request carries `_meta.progressToken`,
the server answers with `text/event-stream`. It sends
`notifications/progress` with that token when the selected turn's status
changes, and at least every 10 s, with a short message such as "running" or
"queued behind 1 message". The final result follows on the same stream.
Progress carries status only, never message text. Without a token the
answer is plain JSON. Progress is request-scoped, so it needs no
server-initiated request and no `GET /mcp` stream.

**Bounds.**

- Codex's default `tool_timeout_sec` is 60 s, so a single wait is capped at
  50 s and defaults to 30 s.
- Claude Code has no per-request timer for stdio servers and a 30 min idle
  window. Its wall-clock default is about 28 h, and progress does not extend
  it, so the cap is not tight there.
- Codex's documentation does not say that progress extends its tool timeout,
  so the cap, not progress, keeps a Codex call inside 60 s. Claude Code
  counts progress as activity for its idle timer.
- A longer wait is a loop of calls, which the skill and the CLI's `--wait`
  do.

### Setting to turn it off

`enableMcpServer` (default `true`) and `mcpServerAccess` are added to
`ServerSettings` and `ServerSettingsPatch`, validated in `control.rs`, and
published as `mcp_server_signal()`. Changes apply live and are logged at info
in `server.log`. When the server is off:

- the relay refuses to start, as above;
- client calls get the typed `McpServerDisabledError`;
- in-flight waits and progress streams end with it, which is what ending the
  open MCP sessions means here, because client principals hold no HTTP
  session;
- auth sessions are not revoked, so turning the server back on needs no new
  pairing, and a relay that kept running works again on its next call;
- provider `preview_*`/`device_*` are unaffected.

Default on adds no capability. A same-user process can already run
`bibcode pairing issue`, and an SSH login already owns the data root.

## Answers to the open questions

- **How does `bibcode mcp` find the server?** Through the endpoint record. The
  server writes it, a loopback `--url` overrides it, the endpoint proof checks
  the listener before any credential exists, and the Settings row shows the
  full command for the selected environment.
- **Remote HTTP?** MCP OAuth (R1), in a later slice. MCP OAuth requires PRM,
  PKCE and an authorization endpoint, none of which BiBCode has. Tokens issued
  there are `mcp-client` sessions bound to the `/mcp` resource (RFC 8707).
  The access level chosen on the consent page is stored in the session's
  `mcp_access` and capped by `mcpServerAccess`. A static bearer (R2) is
  rejected.
- **Do provider and client credentials share `/mcp`?** Yes. The token form
  tells them apart, tool lists differ per principal, and every tool checks its
  scope.
- **Does each stdio launch mint a new session, or reuse one?** Each launch
  mints, revokes on exit, and sweeps orphans. Nothing is stored. A stored
  token would be one more live bearer at rest, and per-launch sessions keep
  Authorized clients showing one row per running agent.
- **Approvals?** Keep the upstream stance in slice 1. A later
  `respond_to_approval` would need `_meta["anthropic/requiresUserInteraction"]: true`
  and an explicit per-environment opt-in that defaults off. Claude Code
  prompts on every such call, even in bypass modes, but other harnesses do not
  honor the key.
- **"What BiBCode needs first" (issue comment):**
  1. Discovery: the record, verified by the endpoint proof.
  2. Transport: thread tools on `/mcp` through B1.
  3. Desktop entry: `<desktop exe> mcp`. The data-root pairing credential is
     verified as accepted (see Current behavior).
  4. Credentials: the narrowed issuer and revocation through the data root.
- **"Suggested additions" (issue comment):** the CLI section below, the
  `remote-access.md:171` correction, a scripted check in
  `cross-platform-validation.md`, and the profiler items below.

## CLI front end (next slice)

`bibcode thread`, also available as `<desktop exe> thread`, is a thin client
of the same tools. It is modelled on the upstream project's thread CLI
(upstream PR 22732).

- **Connection.** The same discovery, mint, revoke and sweep as the relay. It
  calls `/mcp` over HTTP in the modern era.
- **Subcommands.**
  - `list`
  - `start <project> <message|->`: `.` means the project containing the
    current directory, matched client-side from `list` results.
  - `send <thread> <message|->`: queues, never interrupts.
  - `show <thread>`
- **Flags.** `--json`, `--base-dir`, `--title`, `--provider`/`--model`, and
  `--wait`, which calls `wait_for_thread` in 30 s slices on the returned
  `messageId`.
- **Output.** `--json` prints `{ threadId, messageId, status, reply, error }`,
  even on failure.
- **Exit codes.** 0 on success, 1 on failure or interruption, 2 when a person
  must answer in BiBCode.
- **Profiler coverage.** `thread` dispatches after `crash::attach()`, and it
  never logs message text.

## Protocol, schema and persistence changes

- **Contracts.** `ServerSettings`/`ServerSettingsPatch` gain `enableMcpServer`
  and `mcpServerAccess`, with fixtures. Server config gains
  `mcpLaunch: { argv }` (see Launch command), so the UI never guesses a path,
  a root or a state. Both additions are optional.
- **Auth.** The `issue_mcp_pairing_link` issuer, the `mcp-client` audience
  rule in every authenticate path, the per-credential ceiling, and the
  `McpServerDisabledError` tag.
- **Migration 55, `McpClientAccessAndRequests`.** A nullable `mcp_access`
  column on `auth_pairing_links` and `auth_sessions`, and the
  `mcp_tool_requests` table
  (`session_id`, `client_request_id`, `tool`, `arguments_digest`,
  `commands_json`, `created_at`, primary key on the first two). Only the new
  issuer writes `mcp_access`, and an `mcp-client` session whose ceiling is
  `NULL` is treated as `read-only`, so a missing value fails closed.
- **HTTP.** `/mcp` gains Origin and header validation, version validation,
  principal kinds, sessionless client principals, and the event-stream answer
  for progress. `POST /mcp/endpoint-proof` is new, loopback-only, and listed
  in `ROUTE_INVENTORY` as unauthenticated.
- **Files.** `server-runtime.json` (now holding `proofKey`) and
  `<state dir>/mcp-clients/*.json`.
- **RPC.** No new RPC methods. One `pub(crate)` registry invocation entry.

## Trust boundaries

- **Who can launch.** Running `bibcode mcp` or `ssh <host> bibcode mcp` takes
  filesystem access to the data root, the same boundary as
  `bibcode pairing issue`, which already mints more.
- **What the credential reaches.** Only `/mcp` (audience), with
  `orchestration:read orchestration:operate` and the lower of its own ceiling
  and the environment's.
  Never `terminal:operate`, `access:*` or `relay:*`. Destructive and settings
  operations have no tools, and the audience rule stops the credential from
  reaching the RPC methods that would perform them.
- **Approvals.** Approvals stay with a person.
- **Tool inputs.** Tools accept ids, never paths or commands.
- **Provider credentials.** Unchanged in reach, with explicit scope checks now.
  They cannot call thread tools.
- **Secrets.** Tokens never appear in argv, environment, logs or tool output.
  Logs carry the tool name, thread id, outcome and duration, never arguments,
  prompts or replies.
- **Untrusted content.** Thread content comes from agents and tools. Results
  mark it, and the skill tests prompt injection.
- **Who receives the credential.** The relay talks only to loopback, and it
  sends the pairing credential and the bearer only after the listener has
  proved it holds the per-boot `proofKey` from the owner-only record. A
  listener another user bound on a stale port, or after the pid was reused,
  cannot answer, so it receives neither credential nor prompt. The proof
  route reveals nothing secret: it answers an HMAC over a nonce the caller
  chose.

## Failure, cancellation, reconnect and concurrency

- **Cancellation.** A cancelled `tools/call`, whether the stdio cancellation or
  a closed HTTP request, stops the tool. Once the dispatch is handed to the
  engine, the command finishes durably (the existing post-enqueue rule), and a
  retry with the same `clientRequestId` re-dispatches the stored commands,
  which replay by receipt state.
- **Crash before enqueue.** The `reserved` receipt stays. A retry sends the
  identical stored payload, so admission resumes it instead of reporting it
  done or refusing it as a conflict.
- **Server restart.** Auth sessions survive, there is no HTTP session to
  lose, and the relay re-reads the record and repeats the proof. A wait in
  flight fails with a transport error, and the agent calls again.
- **Server shutdown.** The MCP control service refuses new calls and cancels
  waits right after `profiler.begin_stopping()`, before
  `orchestration.shutdown()`.
- **Maintenance.** During an update quiesce, the admission gate refuses
  mutating tools with `UpdateMaintenanceActiveError`.
- **Limits.** At most 8 concurrent calls and 4 waits per client session, and
  32 waits per environment. Beyond that, a tool error says to retry.

## Performance on hot paths

- **Per call.** One SQLite point read to authenticate (as for every bearer
  route), then the mapped handler. `tools/list` is static per principal.
- **No MCP client.** Zero cost: no receivers and no tasks, and timers are
  `None` while the profiler is off.
- **Each wait.** One broadcast receiver, which clones every environment event,
  as an open thread view does. It does an id comparison per event, and at most
  one targeted read per 100 ms burst. Progress adds one small frame per status
  change and at most one every 10 s. The limits above and the 50 s cap bound
  the cost.
- **`read_thread`.** One keyset page with `LIMIT` on the existing message
  index, and at most 16,000 characters per message. Its cost depends on the
  page size, not on the thread's history.
- **Retries.** One indexed `INSERT OR IGNORE` and read per mutating call that
  carries a `clientRequestId`.
- **Truncation.** Re-serialization is bounded by the item limit (200 at most).

## Profiler coverage

- **Child processes.** None new. The relay is started by the harness, and
  providers start through existing turn delivery.
- **RPC methods.** No new methods. Dispatches through B1 keep the registry's
  timing under their RPC names. Each tool call is timed as `mcp.<tool>` with
  `RequestTimer::unary`. An `mcp.*` name is long-running whenever it waits
  or any method it dispatches to is, so `mcp.wait_for_thread` and
  `mcp.list_providers_and_models` (which calls
  `server.getProviderCapabilities`, a cold probe) join `is_long_running`
  (`diagnostics/profiler/latency.rs:106-159`).
- **Worktree removal.** None.
- **Binaries and re-exec modes.** `mcp` (and later `thread`) dispatch after
  `crash::attach()` in both `main.rs` files.
- **Shutdown.** The MCP service stops before profiler teardown.
- **Logs.** Failures at the `/mcp` boundary are logged with `tracing::warn!`.
  No prompt or message text is logged, and nothing new goes into fingerprints.
- **Documentation.** The `mcp.*` timing names are added to
  `docs/skills/bibcode-profiler/references/` and the Profiler section.

## UI (against UI.md)

Settings → Agents gets an **Outside agents** section, because it is an agent
activity. It uses `ProfilerSection.tsx`'s environment picker when several
environments are connected.

- **MCP server** (switch). Description: "Let AI tools on this computer, or over
  SSH, operate this environment's threads." Turning it off asks nothing,
  because it is reversible.
- **Agents may** (Read only, Supervised, Auto-accept edits, Full access, with
  the composer's labels). Description: "Threads an MCP agent starts or
  messages never run with more access than this. If you raise it, agents
  already connected keep their old limit until their MCP server restarts."
  While the server is off it is disabled, with "Turn on MCP server first."
- **Launch command.** Read-only text built from `mcpLaunch.argv` and the
  selected environment's launch context (see Launch command), so it carries
  the data root, the `dev` state and any WSL or SSH wrapper. It has **Copy**,
  and a menu with "Copy for Claude Code" (`claude mcp add bibcode -- <cmd>`)
  and "Copy for Codex" (`codex mcp add bibcode -- <cmd>`). This follows
  UI.md: show commands instead of making users remember them.
- **Older server.** For a server too old to have the setting, the rows are
  disabled with "Update this server to use outside agents."
- **Reset.** Each row has a reset action when it differs from the default.

The `vercel-react-best-practices` and UI.md reviews apply.

## Docs and skill

- **User guide.** `docs/user/mcp.md`: setup per install (server, desktop on
  each OS, WSL, SSH), the Claude Code and Codex commands and timeouts, a tool
  reference, the safety model, revocation versus turning the server off, and
  troubleshooting. It is linked from `docs/README.md`.
- **Living docs.** Update:
  - `remote.md`: replace the invariant at 1651-1655, and cover `/mcp`
    principals.
  - `environment-auth.md`: the MCP issuer and audience.
  - `rpc-and-orchestration.md`: the tools and local invocation.
  - `overview.md`: the Profiler and MCP sections, and the Windows update note
    at 1962-1964, which now also ends `mcp`.
  - `remote-access.md:171`.
  - The testing runbooks: an MCP smoke procedure in
    `cross-platform-validation.md`, each desktop page, and `ssh-environments.md`.
- **Skill.** `docs/skills/bibcode-mcp/SKILL.md`, its byte-identical
  `.agents/skills/` and `.claude/skills/` stubs, and `evals/` like the
  profiler's. It is named in `docs/README.md`, and its `description` starts
  "Use when…" and states only triggering conditions. Build it test-first:
  1. Record verbatim baseline failures, from an agent without the skill, for
     these scenarios: start-and-wait, "approve it", a remote host, "clean up
     the worktree", and injected instructions in a transcript.
  2. Write the minimal skill.
  3. Re-run, and close the loopholes.

## Files to change

Server:

- **New in `apps/server/src/mcp/`:** `protocol.rs`, `control.rs` (tool
  registration and thread tools), `wait.rs`, and `relay.rs`.
- **Changed:**
  - `diagnostics/profiler/mcp.rs` and `diagnostics/profiler/latency.rs`;
  - `production/connect_mcp.rs`, `connect_mcp/device_tools.rs`,
    `connect_mcp/tests.rs`, `production/http_routes.rs` (including the proof
    route), `production/orchestration_rpc.rs` (exposing the shell builder),
    `production/control.rs` and `production/runtime.rs`;
  - `rpc/session.rs` (local invocation);
  - `auth/service.rs`, `auth/http.rs` and `auth/mod.rs` (issuer, audience and
    ceiling);
  - `persistence/migrations.rs` (migration 55) and
    `persistence/repositories.rs` (the wait-state read, the bounded message
    page, the request rows and the ceiling column);
  - `config.rs` and `lib.rs` (`mcp` subcommand), `lifecycle.rs` (record and
    wiring), and `main.rs`.

Desktop: `apps/desktop/src-tauri/src/main.rs`.

Contracts: `packages/contracts/src/settings.ts`, server config, and fixtures.

Shared: a launch-command quoting helper with POSIX and Windows rules under an
explicit `packages/shared` subpath, with tests.

Web: `apps/web/src/components/settings/OutsideAgentsSection.tsx` with its
tests, and `SettingsPanels.tsx`.

Docs: those listed under Docs and skill, plus `docs/skills/bibcode-mcp/` and
the stubs.

## Test plan (written to fail first)

Protocol:

- The shared module answers both eras as the profiler did. Profiler tests
  pass unchanged.
- Legacy `initialize` with `2099-01-01` answers 2025-11-25. This fails today
  at `connect_mcp.rs:1010`.

`/mcp` (`connect_mcp/tests.rs`):

- An `Origin` header gets 403.
- A modern request with a mismatched `Mcp-Name` gets 400 and `-32020`.
- A standard-scope session bearer gets 401.
- A provider token lists no thread tools, and a client session lists no
  `preview_*`.
- Each kind's call to the other's tool is refused with a scope error.
- A legacy client principal's `initialize` returns no `Mcp-Session-Id`, and
  its later calls succeed with only the bearer and `MCP-Protocol-Version`.
- `/mcp/endpoint-proof` returns the expected HMAC for a loopback peer and
  refuses a non-loopback peer.

Auth:

- The MCP issuer mints exactly the two scopes, with subject `mcp-client` and
  the requested ceiling, and the exchange copies the ceiling into the session.
- Exchange cannot widen them.
- With a Full access credential and the setting lowered to Supervised, the
  effective ceiling is Supervised. Raising the setting back does not raise a
  Supervised credential.
- An `mcp-client` token is refused by an HTTP bearer route, by the WebSocket
  ticket, and by `/api/orchestration/dispatch`. The test iterates
  `ROUTE_INVENTORY`, and the unauthenticated `/mcp/endpoint-proof` is the one
  route it skips, with an assertion that the route reads no bearer.

Integration, with the real registration, engine and SQLite, and only the
provider faked:

- start then wait returns the reply;
- send while running is queued, then promoted;
- steer, whose two commands carry different ids;
- overlapping turns: send M1, then M2; after M2 completes, a wait on M1
  returns M1's turn and reply, not M2's, and a delayed retry of that wait
  returns the same;
- a wait without `messageId` returns when the thread is idle and names the
  newest `turnId`;
- a wait timeout leaves the turn running and the event sender's
  `receiver_count` back at baseline;
- a cancelled wait releases its receiver too;
- a wait with `timeoutMs: 300000` is clamped to 50,000 ms and reports it;
- a wait with a `progressToken` gets an event stream carrying at least one
  `notifications/progress` with that token and then the result, and no
  message text in the progress;
- question and answer;
- an approval cannot be answered;
- interrupt;
- the same `clientRequestId` twice, sequentially or concurrently, gives one
  stored row, one turn and the same ids;
- the same `clientRequestId` with the same text but another model, provider
  or mode returns `idempotency_conflict`;
- a retry after a crash between reservation and enqueue (a `reserved`
  receipt with no delivery row) resumes delivery and returns the turn only
  after it is admitted;
- a retry of a rejected command returns the original error, not success;
- two calls without `clientRequestId` start two turns;
- with the Supervised ceiling, an explicit `full-access` start is refused, an
  omitted mode runs `approval-required`, and a send or an answer to a Full
  access thread is refused;
- `read-only` hides and refuses the operate tools;
- `read_thread` on a thread with 10,000 messages reads one page with the SQL
  `LIMIT` (asserted by counting rows read), a 100,000-character message is
  recovered in full through `textOffset`, and a truncated turn patch is
  recovered in full through `get_turn_diff`'s cursor.

Setting:

- Off: client calls get `McpServerDisabledError`, an open wait ends, and
  provider `preview_*` still works.
- On again: the same token works, and a running relay's next call from a
  legacy-era client succeeds with no new `initialize`.
- The relay exits 1 with the message before minting (no pairing link row
  created).

Discovery:

- the record is written after bind, is mode 0600, is removed on shutdown, and
  is not overwritten by a second server that fails the guard;
- a stale record whose pid is gone makes the relay exit 1 before minting;
- a replacement listener on the recorded port, which cannot answer the proof,
  makes the relay exit 1, and the listener receives no `/oauth/token` body
  and no `Authorization` header;
- a listener that forwards the proof request to the real server on another
  port fails the proof;
- `--url` with a non-loopback host is refused before any request;
- a record with a `null` `dialHost` exits 1 with its message.

Launch command:

- `mcpLaunch.argv` carries `--base-dir` for a custom root and `--dev-url` for
  the `dev` state;
- the UI's command for a WSL environment uses that distribution and the
  server's binary and root, and the SSH command quotes the remote argv for a
  POSIX shell;
- the quoting helper round-trips paths with spaces, quotes and `$`.

Relay (in-process, against a test server):

- concurrent list during a wait;
- `notifications/cancelled` cancels the server-side wait;
- a legacy client's negotiated version is sent as `MCP-Protocol-Version`, and
  no `Mcp-Session-Id` is sent;
- a server restart on a new port mid-session: the relay re-reads the record,
  repeats the proof, and the next legacy-era call succeeds without
  reinitializing;
- SSE progress frames reach stdout as separate lines before the result;
- EOF revokes the session (`revoked_at` set);
- the orphan sweep revokes a dead pid's session;
- 401 does not re-mint;
- `--access` above the setting exits 1, and `--access read-only` mints a
  Read only credential.

Profiler:

- `is_long_running` holds for `mcp.wait_for_thread` and
  `mcp.list_providers_and_models`, and for every `mcp.*` name that maps to a
  long-running RPC method (the test iterates the tool table);
- a captured tracing subscriber never sees the prompt text.

Desktop: `desktop_dispatch` recognizes `mcp`.

Web:

- contract defaults decode;
- the section renders the picker, copies the commands, and explains its
  disabled states.

Skill: baseline transcripts recorded before `SKILL.md` exists.

## Verification

- Focused Rust and web tests, `cargo fmt --all --check`, Clippy with
  `-D warnings` on the server and desktop, `vp check`, `vp run typecheck`, and
  `check:contracts`.
- The UI.md and `vercel-react-best-practices` reviews.
- Manual smoke tests:
  - `claude mcp add bibcode -- bibcode mcp`, then start, wait and diff;
  - the same through `ssh <host> bibcode mcp`, and through `<desktop exe> mcp`
    on macOS, Windows and Linux;
  - the copied command for a WSL environment and for a `dev` server;
  - Codex with its default timeouts, including a `wait_for_thread` at the
    50 s maximum, which must return before Codex's 60 s tool timeout;
  - turning the setting off mid-wait;
  - revoking the client in Authorized clients.

## Rollout

Each step lands with its tests:

1. The protocol module, with no change in behavior.
2. `/mcp` hardening: Origin (after the provider launch smoke test), versions,
   per-call scopes, timing.
3. Migration 55, the auth issuer, the audience and the ceiling.
4. Local invocation and the tools, with retries, bounded pages, turn-scoped
   waits and progress.
5. The setting and the UI.
6. The record, the endpoint proof, the relay, and desktop dispatch.
7. Docs and the skill.
8. In a follow-up: `bibcode thread`, then remote HTTP with OAuth, then the
   later tool slices.

Compatibility:

- An older relay against a newer server works.
- A newer relay refuses an older server.
- An older UI ignores the new settings fields.

## Risks

- **Windows GUI subsystem.** Stdio pipes in a GUI-subsystem desktop executable
  need a native Windows run. A Windows update ends a desktop-hosted `mcp`
  process; this is documented.
- **The Supervised default stalls on approvals.** An MCP thread waits at its
  first approval until someone opens BiBCode. The wait reports
  `awaiting_approval`, and users can raise the ceiling.
- **A missed authenticate path.** It would let an `mcp-client` token reach
  RPC. The `ROUTE_INVENTORY` test is the guard.
- **Cached tool lists.** A harness that cached a tool list keeps showing tools
  after the setting changes, as `remote.md:1705` already notes for providers.
  Calls still fail with a typed error.
- **The endpoint proof depends on the record's secrecy.** Anyone who can
  read `server-runtime.json` can answer the proof. That reader already owns
  the data root, which mints credentials anyway, so the boundary does not
  move. A proof failure after a crash leaves the agent without BiBCode until
  the server starts again; the message says so.
- **Streaming one answer.** `/mcp` bodies are buffered today. The progress
  answer needs a streaming body for `wait_for_thread` alone, and its
  cancellation must still drop the wait's receiver. The receiver-count test
  covers both answer forms.
- **Request rows.** `mcp_tool_requests` grows with mutating calls that carry
  a `clientRequestId`. Rows older than 24 h are pruned on insert, which also
  ends their retry window.
- **Harness protocol differences.** Claude Code negotiates 2026-07-28 only on
  newer builds, and the revision Codex supports is unverified. Both eras are
  tested. Whether Codex sends a `progressToken` is also unverified; without
  one the wait answers plain JSON.

References:

- [MCP 2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [Claude Code MCP](https://code.claude.com/docs/en/mcp): timeouts,
  `anthropic/maxResultSizeChars`, `anthropic/requiresUserInteraction`
- [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli):
  `startup_timeout_sec` 10 and `tool_timeout_sec` 60
- The upstream project's `docs/orchestration-v2/orchestrator-mcp-server.md` and
  `docs/user/outside-agents.md`

## Review

Codex reviewed the first draft. Each finding was checked against the source
before it was applied.

1. **Blocking: the retry shortcut could report work that never happened.**
   Accepted. Receipts have four states and compare the full digest
   (`engine.rs:2060-2133`), a matching `reserved` receipt is resumable
   (`repositories.rs:597-630`), and the digest covers `createdAt`
   (`delivery.rs:115`), so only an identical payload can replay. The tool
   layer now stores its first commands in `mcp_tool_requests`, compares the
   complete arguments, and re-dispatches the stored payloads so the existing
   admission replays by receipt state. A call without `clientRequestId` gets
   fresh UUID v4 ids, and the queued start and the steer get separate ids.
   The SHA-derived ids are gone. This adds migration 55.
2. **Major: the ceiling was not bound to the credential.** Accepted. The
   issue asks for a credential-bound ceiling, and an answer resumes the
   provider directly (`provider_runtime.rs:7678-7681`). The ceiling is now
   stored per credential in `mcp_access`, every call uses the lower of it and
   `mcpServerAccess`, and `answer_question` is checked like `send_message`.
   `interrupt_turn` stays unchecked because it stops work.
3. **Major: discovery did not authenticate the listener.** Accepted, with a
   stronger check than comparing identifiers. `bootId` and
   `storageInstanceId` are public in the environment descriptor
   (`http.rs:490-530`), so a listener could replay them. The relay now
   requires an HMAC proof keyed by a per-boot secret that only the owner-only
   record holds, and bound to the listening port, before it mints anything.
   `--url` is loopback-only in slice 1, and tests cover stale records,
   replacement listeners and a forwarding listener.
4. **Major: legacy sessions could not recover.** The defect is real
   (`connect_mcp.rs:988-993`). The fix differs from the suggestion: client
   principals get no HTTP session at all, which the legacy transport allows,
   so a restart or an off/on cycle leaves nothing to rebuild. This is
   simpler than a reinitialization step. Tests cover restart and off/on with
   a legacy-era client.
5. **Major: a wait could return another turn's reply.** Accepted. The wait
   now resolves the selected turn through `pending_message_id` or the
   message's `turn_id`, and returns that turn's state and
   `assistant_message_id` text. A test covers overlapping turns and a delayed
   retry.
6. **Major: the launch command could point at the wrong environment.**
   Accepted (`config.rs:206-212`, `:1083-1090`; `backend.rs:237-269`). The
   server reports an argv with its root and its `dev` selector, the desktop's
   known WSL or SSH target wraps it, and a shared helper quotes it.
7. **Major: pages did not bound the database work.** Accepted
   (`engine.rs:7152-7160`). `read_thread` now reads one keyset page with
   `LIMIT` on the existing index. `textOffset` and the diff cursor recover
   truncated content, and a test covers a large history.
8. **Major: progress was deferred and waits could outlast Codex.** Accepted.
   A single wait is capped at 50 s, and request-scoped progress ships in
   slice 1 when the caller sends a `progressToken`. Progress does not extend
   Codex's timeout, so the cap is what keeps waits inside it. The manual
   smoke test runs the maximum wait under Codex's defaults.

**Simpler alternative.** Adopted. The design keeps C with B1 and adds no
application service. It reuses the existing command admission: the new table
only keeps a retry byte-identical and holds no replay logic. Pages are read
directly, waits are short and tied to one turn, and the thread CLI remains a
follow-up.
