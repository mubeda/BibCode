# MCP Named Clients: One Identity Across Runs

Status: Approved 2026-11-07 (Mauro pre-approval; reviewed by Codex and advisor). Issue #280.
Verified at `e222d340ff` (`main` after v0.15.2). Line references are to that commit.

**Implemented 2026-11-07 (lane L12).** Corrections to this note, recorded here:
`--client` with `authorize`, `call` or `tools` exits 1, not 2, because `main.rs` maps every
usage error to 1 and exit 2 means a person must answer in BiBCode. The named session takes
its `mcp_named_client_id` from its link inside the fenced insert, so `NewAuthSession` gains
no field; `revoke_session` uses `Repositories::revoke_auth_session_and_identity`, which runs
the cascade described under [Ending an identity](#ending-an-identity). The boundary test
found that a stored request past its 24 hours was still replayed until a later insert pruned
it; reads of `mcp_tool_requests` now skip rows past the window.

**Revision 1 (2026-11-07)** answers the Codex review (two P2 findings, see
[Review findings and resolutions](#review-findings-and-resolutions)) and records Mauro's
answers to the four open questions as decisions 5, 7, 8 and 9.

This note makes the
[P1c section](./2026-11-02-outside-agent-control-design.md#p1c-named-clients-split-to-a-later-release)
of the outside-agent design implementation-ready. It keeps that section's decisions,
re-anchors every reference to current source, and records where #281 already built part
of it. It amends one answer of the
[2026-10-24 MCP design](./2026-10-24-mcp-operate-server-design.md) (`:634-637`, "Each launch
mints, revokes on exit, and sweeps orphans. Nothing is stored."): each launch still mints
and revokes, but with `--client <name>` a non-secret identity row is stored.

## Outcome

An outside agent started with `bibcode mcp --client <name>` keeps one identity across
runs:

- a retry with the same `clientRequestId` after a restart, within 24 hours of the first
  call, replays the stored request or recorded outcome and does not run the work again.
  The 24 hours are today's window (`REQUEST_ROW_TTL_SECONDS`, `control.rs:50`, pruned by
  `prune_request_rows`, `:1367-1377`, documented at `docs/reference/mcp.md:781`). A retry
  after the window is new work, as it is for every client today;
- it still owns the panels and threads its earlier runs opened;
- a webhook endpoint paired with it stays on when a run exits.

A person's **Revoke** or **Stop** ends the identity, turns its paired endpoints off as
`client-revoked`, and the next run with that name starts a new identity. Each run still
mints its own credential, revokes it on exit, and is swept as an orphan if it dies. No
token is stored. Without `--client`, nothing changes.

## What the code does today (verified at `e222d340ff`)

| Area                  | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Relay flags           | `McpArgs` (`config.rs:791-802`) has `--url`, `--access` and the `authorize`, `call`, `tools` subcommands. No name flag.                                                                                                                                                                                                                                                                                                                                                   |
| Label                 | `agent_label` (`mcp/relay.rs:603-618`): `MCP · <clientInfo.name>`, control characters dropped, 60 characters, `agent` when blank. Many relays share one label.                                                                                                                                                                                                                                                                                                            |
| Mint                  | `mint` (`relay.rs:931-950`) opens the store under `StoreRuntimeGuard` (`open_store`, `:899-918`) and calls `issue_mcp_pairing_link` (`auth/service.rs:3581-3638`): a 60 s link, subject `mcp-client`, random UUID id.                                                                                                                                                                                                                                                     |
| Session id = link id  | Since #281 an `mcp-client` session takes its link's id (`relay.rs:676-677`, `:757-762`).                                                                                                                                                                                                                                                                                                                                                                                  |
| Exchange              | `consume_grant` (`service.rs:2880-2965`) consumes the link in one transaction (`PAIRING_RETURNING_SQL`, `repositories.rs:3722`, requires `revoked_at IS NULL`). `issue_session_from_grant` (`service.rs:1025`) then inserts the session through `create_fenced_mcp_auth_session` (`repositories.rs:2349-2373`, called at `service.rs:2833-2852`), which writes nothing when the link has `revoked_at` set.                                                                |
| Relay revoke          | EOF, signals, `forget` and the orphan sweep (`relay.rs:794-808`, `:822-830`, `:971-1018`) call `revoke_mcp_credential` (`repositories.rs:2377-2400`): the link (consumed or not) and the session of that id, in one transaction.                                                                                                                                                                                                                                          |
| Person revoke         | **Revoke** → `revoke_client` (`service.rs:2043-2052`) → `revoke_session` (`:2544-2578`). **Stop** → `stop_client` (`:2061-2100`) = `revoke_client`, then, if revoked or `was_revoked_mcp_client` (`:2328-2339`), the stop handler. **Revoke others** → `revoke_other_clients` (`:2580-2620`). Each emits `ClientRemoved` after dropping the state lock.                                                                                                                   |
| Request scope         | `request_key` (`mcp/control.rs:1233-1252`) keys on the session. `stored_request` (`:1255-1320`) and both `activity.rs` reads (`is_retry` `:556`, the cancelled-call `settle` poll `:596`) map a `CLI · bibcode thread` session to that label in SQL. `mcp_tool_requests.session_id` is therefore already a scope column (primary key with `client_request_id`, migration 58, `migrations.rs:2678-2688`).                                                                  |
| Recorded outcomes     | `outcome.rs` `claim` (`:603-621`), `read_row` (`:624-641`), `insert_running` (`:644-662`) and `settle` (`:688-703`) key on `RequestKey.session_id` directly, so even the thread CLI's label rule does not reach them. Owned slots are per session (`admit_owned`, `control.rs:933-959`).                                                                                                                                                                                  |
| Actor                 | `principal_actor` (`activity.rs:70-80`) and `actor` (`:83-85`): `{ kind, clientId: <session>, label }`. The feed's `agent.call` (`mcp/tools/feed.rs:398-414`) builds it from `mcp_activity`. Webhooks' `redacted_actor` (`webhooks/events.rs:177-187`) keeps id-shaped `kind` and `clientId`.                                                                                                                                                                             |
| Stop's turns          | `interrupt_turns_of` (`activity.rs:828-878`) interrupts running turns whose latest user message's `actor_json.clientId` is the session (`RUNNING_TURNS_SQL`, `:754-764`).                                                                                                                                                                                                                                                                                                 |
| Panel ownership       | `check_source_is_callers` (`mcp/tools/panels.rs:406-444`): the caller's session is the thread's requester `clientId`, or the latest user message's actor `clientId`.                                                                                                                                                                                                                                                                                                      |
| Webhook pairing       | `pairedClientId` must be a live `mcp-client` session (`webhooks/rpc.rs:328-339`, `store.rs:395-409`) and is stored in `webhook_endpoints.paired_session_id`. The dispatcher runs `reconcile_pairings` (`webhooks/mod.rs:1047-1056`) before each pass and on every Authorized clients notice; `orphaned_pairings` (`store.rs:378-392`) finds enabled endpoints whose session is gone or revoked and disables them as `client-revoked`.                                     |
| UI joins              | `McpAgentsPanel.tsx:106-111` lists a revoked agent with running turns so Stop stays in reach; rows and the indicator join `sessionId === clientId` (`McpAgentsPanel.tsx:110`, `McpAgentIndicator.tsx:26`). `WebhooksTab.tsx` `PairedClientSelect` (`:1029-1063`) offers sessions and labels the value by session id; the on/off toggle re-sends `pairedClientId` (`:415`).                                                                                                |
| Store access by relay | The relay's `open_store` (`relay.rs:899-918`) calls `Database::open_existing`, which neither migrates nor runs the ledger check. That check (`validate_bibcode_schema`, `migrations.rs:146-193`, "not an exact prefix of this binary") runs only at server startup and in offline inspection (`persistence/store.rs:254`, `:270`, `:370`). So a relay of either version opens the other's store, and only its SQL decides whether that works. The newest migration is 69. |

## Domain terms

- **Named client.** A durable, non-secret identity a person's agent opts into with
  `--client <name>`. It has an id (`nc_` plus a UUID, so it never equals a session id),
  a name, `created_at` and, once ended, `revoked_at`. It holds no token and no access level.
- **Run.** One `bibcode mcp` process and its `mcp-client` session. A named client has zero
  or more live runs.
- **Request scope.** The key a `clientRequestId` is remembered under: the named client's
  id, else `CLI · bibcode thread` for that CLI's sessions, else the session.
- **Ending an identity.** Setting `revoked_at` on the named client. Only a person does this
  (Revoke, Stop, Revoke others). A run exiting, or being swept, never does.

## Decisions

1. **Scope is computed once, from the authenticated principal.** `ClientPrincipal`
   (`control.rs:520-529`) gains `request_scope: String`, filled in `authenticate`
   (`:708-720`) from the cached session record: `mcp_named_client_id`, else the thread
   CLI label when `client.label == thread_cli::LABEL`, else the session id. `RequestKey`
   gains `scope`; every keyed SQL statement and the claim map use it. The three SQL
   `CASE WHEN client_label = …` expressions are deleted. Rejected: a SQL helper on every
   query, which is today's shape and is what let `outcome.rs` miss the rule.
2. **Cancellation, live controls, owned slots and presence stay per session.** A run that
   exits mid-call has its work interrupted and recorded `unknown`, as today; the next
   run's retry reads `unknown` and never re-runs it. Two live runs of one name share
   claims and stored requests but each has its own 2 owned slots.
3. **The fence is #281's, extended by revoking links.** Ending an identity revokes every
   `auth_pairing_links` row carrying its id, consumed or not, in the same transaction. The
   existing fenced insert (link revoked → no session) then covers both races. P1c's extra
   `WHERE EXISTS (… mcp_named_clients …)` clause is not needed. See
   [Ordering argument](#ordering-argument). This holds because pairing links are never
   deleted (there is no `DELETE FROM auth_pairing_links` at `e222d340ff`), so a consumed
   link is still there for the cascade to revoke and for the fence to read.
4. **`clientId` keeps meaning the session; the actor gains optional `namedClientId`.** The
   UI joins stay on `sessionId === clientId`. Ownership and Stop accept either.
5. **Every person action that removes a named client's row ends the identity.** Revoke,
   Stop (also on the row of an earlier run that exited) and Revoke others. This matches
   `docs/reference/webhooks.md:62-64`, which already says Revoke and Stop turn the paired
   endpoint off. Mauro confirmed 2026-11-07.
6. **Webhooks need no new event.** A pairing to a named client stores the named id in
   `paired_session_id`; `orphaned_pairings` treats that id as orphaned only when the named
   client is revoked or missing. Every person revoke already emits `ClientRemoved`, which
   wakes the dispatcher. The column keeps its name (no table rebuild) and is documented as
   "a session id or a named client id".
7. **No idle row.** (Replaced by [Revision 2](#revision-2-idle-rows-and-take-over-across-runs-324).) A named client with no live run has no Authorized clients row, so it
   cannot be revoked from there. Its paired endpoints stay on until edited in Webhooks,
   and the next `--client` run brings its row back. Mauro confirmed 2026-11-07; an idle
   row is a follow-up.
8. **Take over does not carry to the next run.** (Replaced by [Revision 2](#revision-2-idle-rows-and-take-over-across-runs-324).) A restarted agent escapes a Take over
   today because its new run is a new session; named clients do not make that worse.
   Mauro confirmed 2026-11-07: out of scope, a follow-up (the named row would store the
   hand-back level).
9. **An earlier run still running a turn keeps its own row.** It is not folded into the
   live run's row; Stop on it ends the whole identity. Mauro confirmed 2026-11-07.
10. **The relay's SQL works on stores one migration apart.** An unnamed relay touches no
    column or table that migration 70 adds, so it works against a migration-69 store. The
    named path checks for `mcp_named_clients` first. See [Mixed versions](#mixed-versions).

## Design

### Persistence (migration 70, or the next free id at implementation)

```sql
CREATE TABLE mcp_named_clients (
  client_id  TEXT PRIMARY KEY,         -- 'nc_' || uuid
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE UNIQUE INDEX idx_mcp_named_clients_live_name
  ON mcp_named_clients(name) WHERE revoked_at IS NULL;
ALTER TABLE auth_pairing_links ADD COLUMN mcp_named_client_id TEXT;
ALTER TABLE auth_sessions      ADD COLUMN mcp_named_client_id TEXT;
CREATE INDEX idx_auth_sessions_mcp_named_client
  ON auth_sessions(mcp_named_client_id) WHERE mcp_named_client_id IS NOT NULL;
```

- Nullable columns, same shape as migration 46. No backfill: existing rows are unnamed.
  `mcp_tool_requests` is unchanged; its `session_id` column already holds a scope.
- Revoked rows are kept. Shortcut: never pruned; only a person's revokes create them, which
  bounds their number. Upgrade to a prune with `auth_sessions` if that ever changes.
- Add `mcp_named_clients` to `CORE_TABLES` for migration 70 so the validator checks it.
- **The relay's shared queries stay migration-69 compatible** (decision 10). The capacity
  check in `issue_mcp_pairing_link` (`service.rs:3604-3611`) calls
  `list_active_auth_pairing_links` (`repositories.rs:2284-2289`), which uses
  `PAIRING_SELECT`. The relay gets its own `count_active_auth_pairing_links` (`SELECT
  COUNT(*)` with the same `WHERE`), and `create_auth_pairing_link` names
  `mcp_named_client_id` in its `INSERT` only when it is set. `revoke_mcp_credential` is
  unchanged. The server keeps the full selects below.
- `AUTH_SESSION_SELECT` (`repositories.rs:3723`), the pairing select and
  `PersistedAuthAuthoritySnapshot` read `mcp_named_client_id` and, through a `LEFT JOIN`,
  the name. `SessionRecord`, `PairingRecord` and `Grant` carry
  `mcp_named_client: Option<NamedClientRef { id, name }>`, so the authority watcher's
  reconcile and the cache round-trip it.

### Relay: `--client <name>`

- `McpArgs` gains `--client <NAME>`. It applies to the stdio relay only; with `authorize`,
  `call` or `tools` it is a usage error (exit 2).
- Validation before any credential (`a_bad_client_name_exits_before_any_credential`): trimmed,
  1 to 60 characters, no control characters, compared exactly. Message: "Choose a client
  name of 1 to 60 characters with no control characters."
- The label is `MCP · <name>` and replaces `agent_label` for this run.
- `mint` calls a new `issue_named_mcp_pairing_link(repositories, name, access, extra)` that
  does, in one `Immediate` transaction: `INSERT … ON CONFLICT(name) WHERE revoked_at IS NULL DO NOTHING`
  (the conflict target must repeat the partial index's `WHERE`) a live row for `name`, `SELECT` the live row's id, insert the link with that `mcp_named_client_id`, bump
  the authority revision. The capacity check stays as in `issue_mcp_pairing_link`.
- Before that transaction, the named path checks `sqlite_master` for `mcp_named_clients`.
  When it is missing (a newer relay next to an older server's store), the relay exits 1
  before any link exists with "Update BiBCode to use --client: this server does not know
  named clients yet." It never relies on a "no such table" error.
- EOF, signals, `forget` and the orphan sweep are unchanged: `revoke_mcp_credential` touches
  the run's link and session only, never `mcp_named_clients`.

### Exchange

`consume_grant` returns the link's named client in `Grant`. `issue_session_from_grant` puts
it on the `SessionRecord`, and the fenced insert writes `mcp_named_client_id`. No new
refusal path: a revoked identity's link is revoked, so the existing fence answers
`invalid_grant` and the relay reports "BiBCode refused this MCP server's sign-in".

### Ending an identity

A repository method `revoke_mcp_named_client(client_id, revoked_at)` runs one `Immediate`
transaction:

1. `UPDATE mcp_named_clients SET revoked_at = ? WHERE client_id = ? AND revoked_at IS NULL`;
2. `UPDATE auth_pairing_links SET revoked_at = ? WHERE mcp_named_client_id = ? AND revoked_at IS NULL RETURNING id`;
3. `UPDATE auth_sessions SET revoked_at = ? WHERE mcp_named_client_id = ? AND revoked_at IS NULL RETURNING session_id`;
4. bump the authority revision when anything changed.

`AuthService` callers:

- `revoke_session` (Revoke, and Stop through `revoke_client`): read the target session's
  `mcp_named_client_id` (from the row, revoked or not). If set, call
  `revoke_mcp_named_client` instead of `revoke_auth_session`; it revokes the target too.
- `stop_client` on a session already revoked (an earlier run's row): `revoke_client`
  returns `false`; when that session names a live named client, end it the same way. Stop
  then reports `revoked: true` as today via `was_revoked_mcp_client`.
- `revoke_other_clients`: `revoke_other_auth_sessions` also ends every named client that had
  a live session among those revoked, in its transaction.
- After the transaction: remove the returned sessions and pairings from the cache, cancel
  their live connections, bump the generation, and emit `ClientRemoved` per session and
  `PairingLinkRemoved` per link that was in the cache.
- **Emission order follows #294.** That lane (committed at `f57f63a2ea`, not yet merged)
  emits access changes under the `AuthService` state lock; the watcher's
  `reconcile_authority_snapshot` sends its changes under its own lock and returns
  `Result<bool, AuthError>`, so the named-client fields reconcile through it unchanged: `self.emit_access_change(&state, change)` takes the held guard, so an emit after
  `drop(state)` does not compile. The cascade therefore mutates the cache and emits each
  `ClientRemoved` and `PairingLinkRemoved` inside the same guard, looping over the removed
  ids before dropping it. It adds no emission path of its own. If #294 changes shape
  before merge, this method uses whatever helper `revoke_session` uses.

### Ordering argument

Mint and revoke are both single `Immediate` transactions on one SQLite store, so they are
serialized:

- **Revoke commits first.** The mint's upsert finds no live row and creates a new identity.
  That run is a "next run" and starts fresh, as specified.
- **Mint commits first.** The revoke's step 2 revokes the new link.
  - Not yet consumed: `PAIRING_RETURNING_SQL` requires `revoked_at IS NULL`, so the
    exchange fails (`a_named_client_revoked_before_its_link_is_consumed_gets_no_session`).
  - Consumed, session not inserted: the fenced insert sees the revoked link and writes
    nothing (`a_named_client_revoked_after_consumption_but_before_the_session_insert_gets_no_session`).
  - Session inserted: step 3 revokes it.

A relay whose credential was revoked never re-mints (`relay.rs:530`), so a running process
cannot re-create the identity; only a new process can.

### One request scope

- `RequestKey { scope, session_id, client_request_id, tool, digest }`. `scope` comes from
  `ClientPrincipal.request_scope`; `session_id` stays for `admit_owned` and live controls.
- `stored_request`: binds `scope` directly; the `CASE` lookup is deleted.
- `outcome.rs`: `claim` keys the map on `(scope, client_request_id)`; `read_row`,
  `insert_running` and `settle` bind `scope`. `Claim` releases the same key.
- `activity::is_retry` and the cancelled-call poll in `activity::settle` take the scope
  instead of the session and drop their `CASE` sub-selects. Activity rows still record the
  session.
- Duplicate delivery: two calls with one id from two live runs meet in the claim map (same
  process) or in `INSERT OR IGNORE` on the primary key (two processes), exactly as two calls
  from one session do today.

### Actor, Stop and ownership

- `principal_actor` writes `namedClientId` when the current session has one;
  `actor(client_id, label, named_client_id)`. It reads it through a new
  `RpcSessionContext::current_client_session()` (`rpc/session.rs`, beside
  `current_client_metadata` at `:431-440`), which returns the current `ClientSessionView`;
  `current_client_metadata` becomes a projection of it.
- The feed's `agent.call` reads it through `LEFT JOIN auth_sessions ON session_id` (rows are
  never deleted). `event_actor` keeps it. `redacted_actor` passes an id-shaped
  `namedClientId` (`nc_` plus a UUID passes `is_id`).
- `interrupt_turns_of(session_id)` reads the session's `mcp_named_client_id` in the same
  database call and runs `RUNNING_TURNS_SQL` with
  `AND (json_extract(actor_json,'$.clientId') = ?1 OR (?2 IS NOT NULL AND json_extract(actor_json,'$.namedClientId') = ?2))`.
  The running-turns loop stays the outer loop, so the index use is unchanged. Stop on any
  row of a named client therefore interrupts the turns of every run, live or exited.
- `check_source_is_callers` accepts `clientId == session` or, when the caller has a named
  client, `namedClientId == its id`, for both the requester and the latest sender.
- Presence and `merge_active` stay keyed by session, so the UI joins are unchanged. A named
  client with a live run and an exited run that still has a running turn shows two rows
  with the same label. Stop appears on the row whose session has running turns, which can
  be only the exited run's row; Stop there ends the identity and interrupts both runs'
  turns. They stay separate rows (decision 9).

### Webhook pairing

- `webhooks.upsert` accepts a `pairedClientId` that is a live `mcp-client` session or a live
  named client id. A session with a named client is stored as the named id. So the toggle
  at `WebhooksTab.tsx:415`, which re-sends the stored value, keeps working.
- `is_live_agent_session` becomes `is_live_pairing_target(id)`: a live `mcp-client` session,
  or a named client with `revoked_at IS NULL`.
- `orphaned_pairings`: an id is orphaned when it matches no live session **and** no live
  named client (`LEFT JOIN mcp_named_clients`). `paired_endpoints(id)` is unchanged.
- `endpoint_view` adds `pairedClientName`: the named client's name, else the live session's
  label, else `null`.

### Contracts (`packages/contracts`)

- `auth.ts` `AuthClientSession`: `mcpNamedClient: Schema.optionalKey(Schema.Struct({ id, name }))`.
  Mirror in `ClientSessionView` and `authRustParity.test.ts`.
- `orchestration.ts` `OrchestrationActor`: `namedClientId: Schema.optionalKey(TrimmedNonEmptyString)`.
- `webhooks.ts` `WebhookEndpoint`: `pairedClientName: Schema.optionalKey(Schema.NullOr(Schema.String))`;
  the `pairedClientId` doc comment says "a session id or a named client id".
- All are optional keys, so older clients decode newer servers and the reverse.

### UI

- `McpAgentsPanel.tsx`: a row with `mcpNamedClient` shows "Keeps its identity across runs".
  Its **Revoke** and **Stop** carry a title: "Ends this agent's identity. Its paired
  webhooks turn off, and its next run starts fresh."
- `WebhooksTab.tsx` `PairedClientSelect`: an option's value is `mcpNamedClient?.id ??
  sessionId`; the trigger shows `endpoint.pairedClientName` when the value matches no
  live option; the help line becomes "Revoking or stopping that client turns this endpoint
  off. A named client's endpoint stays on across its restarts."
- `McpAgentIndicator.tsx`: unchanged.
- Implementation must review these against `UI.md` and `vercel-react-best-practices`.

## Failure, restart, duplicate delivery and concurrency

| Case                                          | Behaviour                                                                                                                                                                                                                              |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server restarts between runs                  | Stored requests and outcomes are keyed by the named id in SQLite; a retry within 24 hours of the first call replays them. A `running` row with no claim answers `restarted`. After 24 hours the row is pruned and a retry is new work. |
| Relay exits mid-mutation                      | Live controls fire on the session revoke; outcome `unknown`. The next run's retry reads `unknown`.                                                                                                                                     |
| Relay dies; next run sweeps it                | The sweep revokes the dead run's link and session only. The identity, its pairing and its stored requests survive.                                                                                                                     |
| Two runs of one name at once                  | Share scope and claims; each has its own session, slots and presence row. Both are revoked when a person ends the identity.                                                                                                            |
| Two names                                     | Different ids, different scopes.                                                                                                                                                                                                       |
| Unnamed relay with the same `clientInfo.name` | Its scope is its session; it never joins a named scope.                                                                                                                                                                                |
| Person revokes during sign-in                 | See [Ordering argument](#ordering-argument).                                                                                                                                                                                           |
| Person ends an identity with no live run      | Only through Stop on an exited run's row (it has a running turn). Plain Revoke has no row to act on (decision 7).                                                                                                                      |
| Missed `ClientRemoved` notice                 | Webhooks reconcile from SQLite on the next pass; the cache reconciles through the authority revision bump.                                                                                                                             |
| Mixed relay and store versions                | See [Mixed versions](#mixed-versions).                                                                                                                                                                                                 |
| Downgrade after migration 70                  | An older binary refuses the store (ledger not a prefix), as for every migration.                                                                                                                                                       |

## Mixed versions

The relay opens the store directly with no ledger check (see the table above), so its SQL
alone decides compatibility.

- **Newer relay, migration-69 store, no `--client`.** Works: the capacity count, the link
  insert and `revoke_mcp_credential` name only migration-69 columns. Test:
  `an_unnamed_relay_signs_in_and_revokes_against_a_store_before_named_clients`.
- **Newer relay, migration-69 store, `--client`.** Exits 1 before any link, as above. Test:
  `a_named_relay_against_a_store_without_named_clients_exits_before_any_credential`.
- **Older relay, migration-70 store.** Works: an older relay has no `--client`, and its
  selects and inserts name only older columns. SQLite fills the new nullable columns with
  `NULL`, so its links and sessions are unnamed. The ledger check never runs on this path,
  so it does not refuse the store. Test:
  `an_older_relays_link_and_session_on_a_migrated_store_are_unnamed` (it inserts and
  revokes through migration-69 SQL against a migrated store).
- **Older server binary, migration-70 store.** Refused at startup by the ledger check, as
  for every migration.

Security: the name is untrusted text, shown as text and never sent to webhooks (only the id
is). Anyone who can run `bibcode mcp` on the data root can attach to a live named identity
by name; that same person can already mint any MCP credential, so no authority is added.

## Test plan

| Acceptance                               | Test                                                                                                                                                                                           | File                                              |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Request ids survive a new run            | `a_named_client_keeps_its_request_ids_across_runs`                                                                                                                                             | `production/mcp_tools_tests/threads.rs`           |
| Names do not share ids                   | `two_named_clients_do_not_share_request_ids`                                                                                                                                                   | same                                              |
| Unnamed relay stays apart                | `an_unnamed_relay_with_the_same_client_info_name_does_not_join_a_named_scope`                                                                                                                  | same                                              |
| Thread CLI scope unchanged               | keep `only_bibcode_thread_credentials_share_their_client_request_ids` (`threads.rs:278`)                                                                                                       | same                                              |
| Replay after restart does not undo twice | `a_named_agent_retrying_git_undo_commit_after_a_restart_replays_the_recorded_outcome`                                                                                                          | `production/mcp_tools_tests/git.rs`               |
| Live runs share a claim                  | `two_live_runs_of_one_named_client_share_one_claim`                                                                                                                                            | same                                              |
| Stop after relay exit                    | `stop_on_a_named_clients_row_interrupts_turns_of_its_earlier_run_after_the_relay_exited`                                                                                                       | `production/mcp_tools_tests/attribution.rs`       |
| Stop unchanged for unnamed               | `stop_on_an_unnamed_session_is_unchanged`; keep `stop_after_revoke_still_interrupts_the_agents_running_turn`                                                                                   | same                                              |
| Panel ownership across runs              | `a_named_client_still_owns_the_panels_it_opened_after_a_restart`                                                                                                                               | `production/mcp_tools_tests/panels.rs`            |
| Revoke before consumption                | `a_named_client_revoked_before_its_link_is_consumed_gets_no_session` (revoke, then exchange)                                                                                                   | `auth/service.rs` tests                           |
| Revoke after consumption                 | `a_named_client_revoked_after_consumption_but_before_the_session_insert_gets_no_session` (`after_consume` hook)                                                                                | same                                              |
| Revoke ends every run and every link     | `revoking_a_named_client_revokes_its_live_sessions_and_unconsumed_links`                                                                                                                       | same                                              |
| Relay exit keeps the identity            | `a_relay_revoke_never_ends_its_named_client`                                                                                                                                                   | same                                              |
| Endpoint survives relay exit             | `an_endpoint_paired_with_a_named_client_survives_its_relay_exiting`                                                                                                                            | `webhooks/tests.rs`                               |
| Person revoke turns it off               | `a_person_revoking_a_named_clients_row_disables_its_endpoints_and_ends_every_run`                                                                                                              | same                                              |
| Unnamed endpoint unchanged               | `an_endpoint_paired_with_an_unnamed_relay_turns_off_when_it_exits`; keep `revoking_a_paired_client_disables_its_endpoints` (`:993`)                                                            | same                                              |
| Relay label and exit                     | `the_relay_labels_a_named_client_and_still_revokes_on_eof`, `a_bad_client_name_exits_before_any_credential`, `a_named_relay_against_a_store_without_named_clients_exits_before_any_credential` | `mcp/relay/tests.rs`                              |
| Retry window boundary                    | `a_named_clients_retry_after_its_request_row_is_pruned_runs_as_new_work` (ages the row past `REQUEST_ROW_TTL_SECONDS`, then a second run retries)                                              | `production/mcp_tools_tests/threads.rs`           |
| Mixed versions                           | `an_unnamed_relay_signs_in_and_revokes_against_a_store_before_named_clients`, `an_older_relays_link_and_session_on_a_migrated_store_are_unnamed`                                               | `mcp/relay/tests.rs`, `auth/service.rs` tests     |
| Migration                                | `migration_70_adds_named_clients_and_nullable_link_columns`                                                                                                                                    | `persistence/migrations.rs`                       |
| Contracts                                | decode with and without the new keys; Rust parity                                                                                                                                              | `packages/contracts/src/*.test.ts`                |
| UI                                       | named row copy; paired select shows the name of an idle named client and re-saves its id                                                                                                       | `McpAgentsPanel.test.tsx`, `WebhooksTab.test.tsx` |

## Files to change

- `apps/server/src/config.rs`: `--client`.
- `apps/server/src/mcp/relay.rs`, `mcp/relay/tests.rs`: name validation, label, named mint, error mapping.
- `apps/server/src/auth/service.rs`, `auth/model.rs`: `issue_named_mcp_pairing_link`, `Grant`/`PairingRecord`/`SessionRecord`/`ClientSessionView`, revoke cascade, `stop_client`, `authenticate_mcp_client` (named id), tests.
- `apps/server/src/persistence/migrations.rs`, `persistence/repositories.rs`: migration, selects, `count_active_auth_pairing_links`, the conditional link-insert column, `revoke_mcp_named_client`, `revoke_other_auth_sessions` cascade, fenced insert column.
- `apps/server/src/mcp/control.rs`: `ClientPrincipal.request_scope`, `RequestKey.scope`, `stored_request`.
- `apps/server/src/rpc/session.rs`: `current_client_session`.
- `apps/server/src/mcp/outcome.rs`: claim and row queries on `scope`.
- `apps/server/src/mcp/activity.rs`: `actor`, `principal_actor`, `is_retry`, `settle`, `RUNNING_TURNS_SQL`, `interrupt_turns_of`.
- `apps/server/src/mcp/tools/panels.rs`, `mcp/tools/feed.rs`: ownership, `agent.call` actor.
- `apps/server/src/webhooks/{rpc,store,events}.rs`, `webhooks/tests.rs`: pairing target, orphan query, view name, redacted actor.
- `apps/server/src/production/mcp_tools_tests/{threads,git,attribution,panels}.rs`, and
  `terminals.rs:261` and `clone.rs:439`, which build `ClientPrincipal` by hand.
- `packages/contracts/src/{auth,orchestration,webhooks}.ts` and tests.
- `apps/web/src/components/settings/McpAgentsPanel.tsx`, `WebhooksTab.tsx` and tests.
- Docs: `docs/reference/mcp.md` (retries "per MCP connection" at `:1376` and the Retries section `:788-840`, the relay section `:98-113`, `:172-202`, revocation `:515`, `:623`), `docs/reference/webhooks.md:62-64`, `docs/user/mcp.md`, the `bibcode-mcp` skill, and the 2026-10-24 design's `:634-637` answer (a pointer to this note).

## Profiler, crash and trace coverage

No new child process, binary mode, RPC method, worktree removal path or service. The relay
still spawns nothing new. The revoke cascade runs inside the existing `/api/auth/clients/revoke`
handler. A refused named sign-in reuses the fenced-insert `tracing::warn!`; a named-client
revoke adds one `tracing::info!` with the id only (never the name, which is client text).
No profiler event or finding changes.

## Follow-ups (recorded, not in this slice)

Both are designed in [Revision 2](#revision-2-idle-rows-and-take-over-across-runs-324), issue #324.

- An Authorized clients row for an idle named client, so it can be revoked with no run
  live (decision 7).
- Take over carrying to the next run of a named client (decision 8).

## Revision 2: idle rows and Take over across runs (#324)

Status: Approved 2026-11-07 (Mauro pre-approval; reviewed by Codex and advisor). Mauro's
answers: Q1 both surfaces, Q2 to Q5 as recommended, migration 71. Verified on the integration branch
at `85fcbe4b3`, which contains this note's implementation and #294.

Revision 2 replaces decisions 7 and 8. Everything else in this note stands.

### Outcome

1. A named client with no live run has a row in Settings → Authorized clients and in
   Settings → Agents. Its **Revoke** ends the identity exactly as Revoke on a run's row
   does: [Ending an identity](#ending-an-identity), paired endpoints off as `client-revoked`,
   the next run starts a new identity.
2. **Take over** on any run of a named client takes over the identity. Every live run goes
   read-only, and every later run starts read-only, until a person presses **Hand back** on
   a run's row or ends the identity.

### What the code does today (verified at `85fcbe4b3`)

| Area               | Behaviour                                                                                                                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authorized clients | `access_snapshot` (`auth/service.rs:776-813`) and `list_clients` (`:2045-2058`) list live sessions only. `ShareTab.tsx:985-993` renders `clientSessions` from the stream snapshot.                                                                                        |
| Stream             | `auth/rpc.rs:33-101` sends a snapshot, then deltas. `PendingMcpAuthorizations` goes out as a whole snapshot so a client that predates it still decodes (`:58-74`). The web reducer replaces the whole payload on `snapshot` (`client-runtime/src/state/auth.ts:33`).      |
| Authority cache    | `load_auth_authority_snapshot` (`repositories.rs:2070-2150`) loads live links, sessions and pending authorizations. `reconcile_authority_snapshot` (`service.rs:3103-3190`) diffs them into `AuthState` and emits under its lock.                                         |
| Revoke             | `revoke_session` (`service.rs:2566-2595`) runs `revoke_auth_session_and_identity`, then `forget_revoked` (`:2599-2624`) emits `ClientRemoved` and `PairingLinkRemoved` under the lock. With no session and no link it emits nothing.                                      |
| Revoke input       | `AuthRevokeClientSessionInput.sessionId` is `AuthSessionId`, a branded `TrimmedNonEmptyString` (`baseSchemas.ts:34-54`). Any `nc_…` id decodes.                                                                                                                           |
| Webhooks wake      | `webhooks.wake_on(auth.subscribe_access())` (`production/runtime.rs:779`) wakes on every access event, so any emitted change triggers `reconcile_pairings`.                                                                                                               |
| Take over          | `set_mcp_access` (`service.rs:2374-2442`): `read-only` stores the replaced level in `mcp_access_hand_back`; any other level must equal it. One session, `set_auth_session_mcp_access` (`repositories.rs:2549-2571`). The relay's link carries the run's own `mcp_access`. |

### Domain terms

- **Idle named client.** A named client with `revoked_at IS NULL` and no live session that
  carries its id. The UI computes it: named clients minus `clientSessions[].mcpNamedClient.id`.
- **Taken over identity.** A named client with `taken_over_at` set. Each run's session still
  holds its own `mcp_access` and `mcp_access_hand_back`; the identity flag decides what a new
  run's session starts with.

### Decisions

- **R2-1. The snapshot carries live named clients; there is no new delta event.**
  `AuthAccessSnapshot` gains `mcpNamedClients: optionalKey(Array({ id, name, createdAt }))`.
  A change goes out as a whole snapshot through a new `AuthAccessChange::McpNamedClients`,
  handled in the stream like `PendingMcpAuthorizations`. Older web clients decode it and
  ignore the key. Rejected: `namedClientUpserted`/`Removed` deltas, which an older client's
  `Schema.Union` refuses.
- **R2-2. The UI derives idleness.** The list only changes when an identity is created or
  ended. A run starting or exiting is already a `clientUpserted` or `clientRemoved` delta,
  and the web recomputes idle rows from the two arrays. Rejected: a server-computed idle list,
  which would need a snapshot on every run start and exit.
- **R2-3. Revoke on an idle row reuses `POST /api/auth/clients/revoke`.** `sessionId` may be a
  live named client id (`nc_` plus a UUID, never equal to a session id). `revoke_session`
  dispatches it to `revoke_mcp_named_client`. No new route, HTTP API entry or client function.
  This follows decision 6, where `pairedClientId` already holds either kind of id. Rejected:
  a separate `/api/auth/named-clients/revoke`, which adds a route in `http.rs`, an
  `environmentHttp.ts` endpoint and a web function for one call.
- **R2-4. `Revoke others` also ends idle named clients.** It removes every other row, and
  decision 5 says a person action that removes a named client's row ends the identity.
  (Open question Q2.)
- **R2-5. The identity stores a flag, not a level.** `mcp_named_clients.taken_over_at`. A new
  run's hand-back level is its own link's `mcp_access`. This keeps `set_mcp_access`'s rule
  that Hand back never raises a session above what it was paired with. Rejected: storing the
  level replaced, which can exceed the next run's `--access`.
- **R2-6. Take over and Hand back apply to the identity.** On a named session, both update
  the flag and every live session of that identity in one transaction. Unnamed sessions are
  unchanged.
- **R2-7. A read-only run of a taken-over identity starts plain read-only.** Its session gets
  `mcp_access = 'read-only'` and no hand-back, as today. The identity stays taken over; a
  later run with a higher level starts read-only with Hand back offered. No API change.
  (Open question Q4.)
- **R2-8. Release happens on a run's row.** An idle row offers Revoke only. Hand back needs a
  run, because the level it restores is that run's own. (Open question Q5.)

### Persistence (migration 71, or the next free id at merge)

```sql
ALTER TABLE mcp_named_clients ADD COLUMN taken_over_at TEXT;
```

- Guarded by `table_has_column`, like migration 70's `ALTER`s. No backfill.
- Migration 70 is not released, but the integration branch has run it, so this is a new
  migration rather than an edit of 70.
- `load_auth_authority_snapshot` also reads `SELECT client_id, name, created_at, taken_over_at
  FROM mcp_named_clients WHERE revoked_at IS NULL ORDER BY created_at, client_id` into a
  `#[serde(skip)]` field, the same shape as `pending_mcp_authorizations`.
- Mixed versions (decision 10) still hold one migration apart. The relay's named mint names
  its columns (`repositories.rs:2394`), and `revoke_mcp_credential` and the sweep name no
  column of `mcp_named_clients`. The session-insert clamp below runs in the server, which
  always matches its store.

### Server

**Cache.** `AuthState` gains `named_clients: HashMap<String, NamedClientRecord { id, name,
created_at_ms, taken_over }>`. `reconcile_authority_snapshot` replaces it and pushes
`AuthAccessChange::McpNamedClients` when the `(id, name, created_at)` set differs. A relay's
mint of a new identity bumps the authority revision, so the watcher picks it up within one
tick.

**Revoke.** `revoke_session(id)`: when `id` starts with `nc_`, run the existing
`revoke_mcp_named_client_on` cascade in its own `Immediate` transaction. `RevokedAccess`
already returns `named_clients`. `forget_revoked` removes them from `state.named_clients` and,
under the same guard, emits `McpNamedClients` after the `ClientRemoved` and
`PairingLinkRemoved` it already sends. That event is what wakes the webhook dispatcher for an
idle identity, which has no `ClientRemoved`. It goes out whenever the store ended an
identity, even if the cache had not yet listed it (a relay mints identities straight into
the store, and the watcher may not have run). `revoke_other_clients` also ends every live
named client (R2-4) in its transaction. `revoke_client`'s current-session check is unchanged,
since a named id is never the current session.

**Take over and Hand back.** `set_mcp_access` on a session with a named client:

1. Take over: `UPDATE mcp_named_clients SET taken_over_at = ? WHERE client_id = ? AND
   revoked_at IS NULL`, then for each live session of the identity the same rule as today
   (keep an existing hand-back, else store the current level unless it is `read-only`),
   `RETURNING session_id, mcp_access, mcp_access_hand_back`.
2. Hand back: the requested level must equal the target session's hand-back, as today. Then
   clear `taken_over_at` and set every live session of the identity that has a hand-back to
   `mcp_access = mcp_access_hand_back, mcp_access_hand_back = NULL`, `RETURNING` the same.
3. Under the state lock: apply the returned rows and the flag to the cache, cancel each
   session's live connections, bump the generation, emit one `ClientUpserted` per session.

**New run's session.** `create_fenced_mcp_auth_session` reads the link's named client's
`taken_over_at` in its transaction. When set and the row's `mcp_access` is not `read-only`,
it writes `mcp_access = 'read-only', mcp_access_hand_back = <the link's level>`. It returns
the effective pair, and `issue_session_from_grant` puts that on the cached record before it
emits `ClientUpserted`.

**Ordering.** Without a lock, this interleaving leaves a stale level in the cache: the
session insert commits, Take over commits and updates the cached sessions it knows, then
issuance publishes its record at the paired level. The watcher would correct it within one
tick, but that window is in the unsafe direction. Issuance already holds `AuthService`'s
`issuance` lock from the session insert to the cache publication, so `set_mcp_access` takes
the same lock from its transaction to its cache update. (Implementation note: the design first
proposed a new `mcp_access_order` mutex; the existing lock already covers issuance.) Both are
rare person or sign-in actions. Revoke keeps today's watcher convergence, because a
stale cached revoked session already fails authentication through the store fence.

**Refresh.** `refresh_session_from_repository` (`service.rs:1339-1385`) reads the session
from SQLite before it takes the state lock, then replaces the cached record. A refresh that
read a writable level, then paused while Take over committed and updated the cache, would
put the writable level back, and `authenticate` builds the MCP ceiling from that cache
(`mcp/control.rs:732-748`). This is true for unnamed sessions today too. The refresh reads
`authority_generation` before its SQLite read and publishes only if it is unchanged under
the lock; otherwise it reads again. Every local mutation (Take over, Hand back, revoke,
issuance) bumps the generation under the lock, so this covers all of them without making
authentication wait on the `issuance` lock. Test:
`a_refresh_that_read_before_take_over_does_not_restore_the_writable_level`.

### Contracts (`packages/contracts`)

- `auth.ts` `AuthAccessSnapshot.mcpNamedClients: Schema.optionalKey(Schema.Array(
  Schema.Struct({ id: TrimmedNonEmptyString, name: Schema.String, createdAt:
  Schema.DateTimeUtc })))`. Doc comment: live named clients, so a client can list the idle
  ones; absent from servers before #324.
- `AuthRevokeClientSessionInput.sessionId` doc comment: a session id, or a live named
  client's id to end an idle identity.
- Rust mirror `McpNamedClientView` in `auth/model.rs`. `authRustParity.test.ts` checks HTTP payloads, not the stream snapshot, so it does not change.

### UI

- One hook in `apps/web/src/state/mcpActivity.ts`, `usePrimaryIdleNamedClients()`: named
  clients from the snapshot minus those with a live session.
- `ShareTab.tsx` Authorized clients: an idle row per idle named client after the session rows.
  Label `MCP · <name>`, grey dot, secondary line "Not running · Keeps its identity across
  runs", **Revoke** with the title "Ends this agent's identity. Its paired webhooks turn off,
  and its next run starts fresh." (the existing `ENDS_IDENTITY` text). The pending text is
  "Revoking…", as for sessions. `Revoke others` stays enabled while an idle row exists.
- `McpAgentsPanel.tsx`: the same idle row with Revoke only. An exited run's "Revoked · N turns
  running" row stays separate (decision 9), so one identity can show both; their secondary
  lines tell them apart.
- A run row of a taken-over identity shows "Taken over (was <level>)" from its own hand-back,
  as today. A read-only run shows "Read only" (R2-7). `McpAgentIndicator.tsx` is unchanged.
- Implementation reviews these against `UI.md`, `vercel-react-best-practices` and the
  `impeccable` audit.

### Failure, restart and concurrency

| Case                                            | Behaviour                                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Server restarts while an identity is taken over | `taken_over_at` and each session's level are in SQLite. The cache loads them. The next run starts read-only. |
| Run exits while taken over                      | Its session is revoked by the relay; the flag stays on the identity.                                         |
| Revoke on an idle row while a run signs in      | The cascade revokes its link, so the fence refuses the session ([Ordering argument](#ordering-argument)).    |
| Revoke on an idle row that a run just made live | The cascade revokes that run too. The person meant to end the identity.                                      |
| Two live runs, Take over on one                 | Both go read-only and both have their live work cancelled. Hand back on either restores both.                |
| Take over or Hand back racing a new run         | Serialized by the `issuance` lock; both orders end with the cache equal to SQLite.                           |
| Revoke of an unknown or ended `nc_` id          | `revoke_session` returns `false`, so the route answers as for an unknown session.                            |
| Missed `McpNamedClients` notice                 | The next snapshot (lag, reconnect, or the watcher's next change) carries the whole list.                     |
| Older web client                                | Ignores `mcpNamedClients`; it shows no idle row, as before.                                                  |
| Downgrade after migration 71                    | An older server refuses the store (ledger not a prefix). An older relay works, as decision 10 says.          |

### Tests

| Acceptance                             | Test                                                                                                       | File                                        |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Idle client listed after its run exits | `a_named_client_whose_run_exited_stays_in_the_access_snapshot`                                             | `auth/service.rs` tests                     |
| Revoke on the idle id ends it          | `revoking_an_idle_named_client_by_its_id_ends_the_identity_and_sends_a_snapshot`                           | same                                        |
| Revoke others ends idle identities     | `revoke_others_ends_idle_named_clients`                                                                    | same                                        |
| Idle Revoke turns endpoints off        | `revoking_an_idle_named_client_disables_its_paired_endpoints`                                              | `webhooks/tests.rs`                         |
| Take over carries to the next run      | `a_taken_over_named_clients_next_run_starts_read_only_with_its_own_hand_back`                              | `auth/service.rs` tests                     |
| Take over reaches every live run       | `taking_over_one_run_takes_over_every_live_run_of_the_identity`                                            | same                                        |
| Hand back releases the identity        | `hand_back_on_one_run_releases_the_identity_and_every_live_run`                                            | same                                        |
| Read-only run of a taken-over identity | `a_read_only_run_of_a_taken_over_identity_has_no_hand_back`                                                | same                                        |
| Race with a new run                    | `take_over_while_a_named_run_publishes_leaves_the_cache_read_only` (`after_session_insert` hold)           | same                                        |
| Refresh racing Take over               | `a_refresh_that_read_before_take_over_does_not_restore_the_writable_level` (hold after the refresh's read) | same                                        |
| Restart                                | `a_taken_over_identity_survives_a_restart`                                                                 | same                                        |
| Agent sees it                          | `a_named_agent_restarted_after_take_over_is_refused_a_mutation`                                            | `production/mcp_tools_tests/attribution.rs` |
| Unnamed unchanged                      | keep the existing Take over and Hand back tests                                                            | `auth/service.rs`, `oauth_flow_tests.rs`    |
| Migration                              | `migration_71_adds_taken_over_at_to_named_clients`                                                         | `persistence/migrations.rs`                 |
| Contracts                              | snapshot decodes with and without `mcpNamedClients`; Rust parity                                           | `packages/contracts/src/auth.test.ts`       |
| UI                                     | idle row with Revoke in Authorized clients and Agents; no idle row when a run is live                      | `ShareTab` test, `McpAgentsPanel.test.tsx`  |

### Files to change

- `apps/server/src/persistence/migrations.rs`, `persistence/repositories.rs`: migration 71,
  named clients in the authority snapshot, the session-insert clamp, the identity-wide access
  update, `revoke_other_auth_sessions` ending idle identities, revoke by named id.
- `apps/server/src/auth/service.rs`, `auth/model.rs`, `auth/rpc.rs`: cache, change, snapshot
  field, `revoke_session` dispatch, `set_mcp_access` under the `issuance` lock, tests.
- `apps/server/src/production/mcp_tools_tests/attribution.rs`, `webhooks/tests.rs`: tests only.
- `packages/contracts/src/auth.ts` and tests.
- `apps/web/src/state/mcpActivity.ts`, `components/settings/remote-servers/ShareTab.tsx`,
  `components/settings/McpAgentsPanel.tsx` and tests.
- Docs: `docs/reference/mcp.md` (Stop, Take over and Hand back; the named-client section),
  `docs/reference/webhooks.md` if its Revoke paragraph needs the idle row, `docs/user/mcp.md`.

### Profiler, crash and trace coverage

No new child process, binary mode, RPC method, HTTP route, worktree removal path or service.
Revoke still runs in `/api/auth/clients/revoke` and Take over in `/api/auth/clients/mcp-access`.
The existing `tracing::info!` for an ended identity covers the idle path; Take over of an
identity adds one `tracing::info!` with the named id and session count, never the name.

### Review findings and resolutions (Revision 2)

| #   | Finding                                                                                  | Verified                                                                          | Resolution                                                                |
| --- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | Codex P2: `refresh_session_from_repository` can restore a writable level over Take over. | Confirmed: SQLite read at `service.rs:1347`, unlocked; cache replaced at `:1378`. | **Fixed in design.** Generation check and re-read; see **Refresh** above. |

### Open questions for review (answered)

1. **Q1. Surfaces.** Idle rows go in both Authorized clients (`ShareTab.tsx`, the issue's
   wording) and Agents (`McpAgentsPanel.tsx`). Recommended: both. `ShareTab.tsx` and
   `state/mcpActivity.ts` are outside this lane's listed files; confirm they are this lane's.
2. **Q2. Revoke others.** It ends idle named clients too (R2-4). Recommended: yes.
3. **Q3. Migration id.** 71, if no other lane adds one. Recommended: the coordinator assigns.
4. **Q4. Read-only runs.** A read-only run of a taken-over identity shows plain "Read only"
   and offers no Hand back (R2-7). Recommended: yes; Take over has no effect on a run that
   cannot write.
5. **Q5. Release with no run.** The idle row offers Revoke only, not Hand back (R2-8).
   Recommended: yes.

## Review findings and resolutions

Codex (gpt-6.1-sol, high), round 1. It found no other actionable issue and accepted
dropping P1c's `EXISTS` clause given decision 3's condition (links stay stored and the
cascade revokes consumed ones).

| #   | Finding                                                                                                                                                                            | Verified                                                                                                                                                                                                                                                                                                                                     | Resolution                                                                                                                                                                                                                                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | P2: "never runs the work twice" is false once `prune_request_rows` deletes the row after 24 h.                                                                                     | Confirmed. `prune_request_rows` (`control.rs:1367-1377`) deletes rows older than `REQUEST_ROW_TTL_SECONDS` (24 h, `:50`), recorded outcomes included.                                                                                                                                                                                        | **Fixed.** The outcome and the restart row state the 24-hour window, which is the documented contract (`mcp.md:781`). A boundary test is added. #280 does not require dedup past 24 hours, so none is designed.                                                                                               |
| 2   | P2: mixed-version claims conflict with store access. An older relay rejects a migration-70 store (ledger check), and a newer unnamed relay hits new columns in the capacity check. | Second half confirmed: adding the column to `PAIRING_SELECT` would break `list_active_auth_pairing_links` on a migration-69 store. First half not confirmed: the relay's `open_store` calls `Database::open_existing`, which does not run `validate_bibcode_schema`; only server startup and inspection do (`store.rs:254`, `:270`, `:370`). | **Fixed.** Relay queries stay migration-69 compatible (decision 10), the named path checks for the table first, and [Mixed versions](#mixed-versions) covers all four directions with tests, including without `--client`. An older relay works on a migrated store because no ledger check runs on its path. |

## Not verified

- #294's emit-under-lock helper as merged (`f57f63a2ea`, reported by that lane; not read here).
- Behaviour on native Windows (no platform-specific code is added).
