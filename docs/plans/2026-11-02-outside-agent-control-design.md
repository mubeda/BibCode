# Outside Agent Control: Webhook Auth, Stable Identity, CLI

Status: Proposed 2026-11-02, awaiting the maintainer's approval. Issue #271. Follows #139 and
amends one answer of the approved
[2026-10-24 MCP design](./2026-10-24-mcp-operate-server-design.md) (see
[Decision 2](#decision-2-a-stable-identity-across-runs)). Verified at `fd98b433068b`
(`main`, the merge of #241). Line references are to that commit.

The stale-doc fix and the `input.*` webhook events change no decision, so they form the
first slice and may land before this note is approved. Every other slice waits for
approval.

## Decisions

### Decision 1: the webhook auth header

**Recommended: one optional bearer token per endpoint.** Each request carries
`Authorization: Bearer <token>`. The token is write-only. `webhooks.list` reports only
whether one is set.

| Option                                   | For                                                                    | Against                                                                                                                                                                              |
| ---------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **One bearer token** (chosen)            | Meets Bridge's reported receiver. One secret, one header, one rule.    | A receiver that wants `X-Api-Key` is not served.                                                                                                                                     |
| A list of custom headers                 | Serves more receivers.                                                 | Every value needs secret handling. Names must be refused (`Host`, `Content-Length`, `Content-Type`, `User-Agent`, `X-BibCode-*`, hop-by-hop). More UI and more ways to leak a value. |
| One header with a configurable name      | Covers `X-Api-Key` with the same single secret.                        | A name field and a refused-name list for a need nobody has reported. It can be added later without breaking `bearerToken`.                                                           |
| A token in the URL query                 | Needs no change.                                                       | The URL is listed unmasked in `webhooks.list` and the form. Receivers rarely accept it.                                                                                              |
| HMAC at the receiver (today's signature) | Already shipped (`docs/reference/webhooks.md:205-226`). Best practice. | Bridge reports that it cannot verify it. The bearer header does not replace the signature: both are sent.                                                                            |

**Hint: set or not set only.** The endpoint returns `bearerTokenSet: boolean` and no
masked characters. A hint would need the value, or part of it, outside the secret store.
A person who is unsure which key is set replaces it. Showing the last four characters is
the alternative if the maintainer prefers it. It needs a stored hint column and is still a partial
secret in client state.

### Decision 2: a stable identity across runs

**Recommended: a named client.** `bibcode mcp --client <name>` attaches each run's
credential to a durable, non-secret identity row. Retries, panel ownership, the actor's
`clientId` and webhook pairing key on that identity. Each run still mints its own
credential and revokes it on exit, and the orphan sweep still runs. No token is stored.

| Option                                                               | For                                                                       | Against                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A named client row, opt-in with `--client`** (chosen)              | Durable identity with no bearer at rest. A person's Revoke still ends it. | One table and two columns.                                                                                                                                                                                                                                                                                                                                                            |
| The label-keyed scope the issue proposes (`MCP · <name>` as the key) | No new table.                                                             | It collides: an unnamed relay is already labelled `MCP · <clientInfo.name>` (`relay.rs:541-554`), so `--client "Claude Code"` would share retries and panels with every unnamed Claude Code relay. A label cannot tell a relay that exited from a person's **Revoke**, so a paired endpoint must either survive both or die with both. It still needs a column to fix either problem. |
| A long-lived credential a person issues                              | One step, and works without the relay.                                    | It puts a live bearer at rest in the agent's config, which 2026-10-24 rejected (`:634-637`, and R2 at `:217-221`). It adds nothing locally: the relay already authenticates with data-root authority. Remote agents already keep one session for a grant's life, because a refresh reuses the session (`auth/service.rs:2162`).                                                       |
| Key every relay by `clientInfo.name`, with no flag                   | No flag to learn.                                                         | It merges every instance of one product (all Claude Code sessions). This is option (a) that 2026-10-24 rejected (`:1373-1374`).                                                                                                                                                                                                                                                       |

**This keeps the 2026-10-24 answer.** "Each launch mints, revokes on exit, and sweeps
orphans" still holds. The only change to "Nothing is stored" is a row holding a name and
dates, and it authenticates nothing. Authorized clients still shows one row per running
agent.

**The name comes from `--client` only.** `clientInfo.name` stays the label of unnamed runs.
Rules: 1 to 40 characters of `a-z 0-9 . _ -`, starting with a letter or digit. A bad name
exits 1 before any credential is minted. `bibcode-thread` is reserved.

**Fold `bibcode thread` into it.** The CLI becomes the reserved named client
`bibcode-thread`, labelled `CLI · bibcode thread` as today. Then the three copies of the
label rule (`mcp/control.rs:1255`, `mcp/activity.rs:556`, `:596`) become one
`COALESCE(mcp_named_client_id, session_id)`. The CLI also keeps panel ownership across
runs. This settles the "Pending approval" CLI scope of 2026-10-24 (`:1382`): approving this
note approves it in this form.

## Open questions

| Question (issue)                                                          | Recommendation                                                                                                                                                                                               | Needs the maintainer?                                                                     |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Can Bridge verify `X-BibCode-Signature` or take a URL token?              | Build P0 either way. `Authorization` is the usual receiver contract, and a URL token is unmasked. Bridge should also verify the signature, which every request keeps.                                        | **Yes**: depends on Bridge's receiver. It sets P0's urgency, not its shape.      |
| One bearer, or custom headers? Hint?                                      | One bearer. `bearerTokenSet` only, with no hint ([Decision 1](#decision-1-the-webhook-auth-header)).                                                                                                         | Only if Bridge needs a non-`Authorization` header, or the maintainer wants a last-4 hint. |
| `approvals` or a new `questions` category?                                | A new `questions` category, labelled **Questions**. A question is not an approval, and the feed names them apart (`input.*`).                                                                                | No                                                                               |
| Label scope or person-issued credential? `--client` or `clientInfo.name`? | A named client row, from `--client` only ([Decision 2](#decision-2-a-stable-identity-across-runs)).                                                                                                          | Approval of this note                                                            |
| Was leaving `projectId` out a privacy choice?                             | No reason is recorded. The X8 payload list never had it (`2026-10-30-mcp-remaining-slices-design.md`, Payload), and `events.rs:57` states only the fact. A project id is as opaque as `threadId`, so add it. | No                                                                               |
| Tags, or is `purpose` enough?                                             | `purpose` is enough. Add no tags until a concrete case needs one, such as a list filter by tag.                                                                                                              | **Yes**: ask Bridge for its case.                                                |
| Is the CLI's shared retry scope approved?                                 | It is replaced by the reserved named client. Approving this note approves that.                                                                                                                              | **Yes** (approval of this note)                                                  |

## Requirements

Each item lists the change, the shapes, secret handling, tests, docs and its slice. "New"
test names are proposals. Contract and Rust shapes change together, and
`vp run check:contracts` runs in every slice that touches `packages/contracts`.

### P1a: stale retry paragraph (slice 1)

- **Change.** Rewrite `docs/reference/mcp.md:200-202`: `bibcode thread` runs share one
  `clientRequestId` scope (as `:192-195` says). Only `send_panel_message`'s "thread you
  opened or last drove" rule does not carry over between runs. Slice 3 changes this again.
- **Tests.** None new. `reference_docs.rs` keeps passing.

### P1b: `input.requested` and `input.resolved` events (slice 1)

- **Change.** `events.rs`: add `INPUT_REQUESTED` and `INPUT_RESOLVED` to `EVENT_TYPES` under
  `"questions"`, and map the two feed kinds in `from_feed_entry` (`:99-110`). The existing
  field copy (`:114`) already carries `requestId` (plain ids only) and `status`
  (`resolved`/`expired`), as for `approval.*`.
- **Contract.** `packages/contracts/src/webhooks.ts`: add both to `WebhookEventType` and a
  `{ key: "questions", events: [...] }` category. The UI gets `CATEGORY_LABELS.questions =
  "Questions"` and the labels "Question asked" and "Question answered"
  (`WebhooksTab.tsx:46-64`).
- **Existing endpoints are unchanged.** Each one stores its own event list, so only new
  endpoints, which default to every event (`WebhooksTab.tsx:66-68`), get the new events.
- **Tests.** `feed_entries_map_to_the_catalog` expects both events.
  `a_payload_holds_ids_and_states_only` covers an input payload.
  `every_webhook_event_is_in_the_webhooks_reference` passes. `WebhooksTab.test.tsx` shows
  the Questions checkboxes.
- **Docs.** `docs/reference/webhooks.md`: the Events rows (`:105-117`), the source note
  (`:121-125`), and the `requestId` row (`:151`) covers questions. `docs/user/webhooks.md`.

### P0: bearer token (slice 2)

- **Input.** `webhooks.upsert` gains `bearerToken`. When it is absent, the endpoint keeps
  its token. `null` clears it, and a string sets or replaces it.
  - Rust: `#[serde(default, deserialize_with = "present")] bearer_token: Option<Option<String>>`,
    where `present` wraps the value in `Some`. `UpsertInput` keeps no `Debug` derive.
  - Contract: `bearerToken: Schema.optional(Schema.NullOr(Schema.String))`.
- **Validation** (`rpc.rs`). Trim the value, then accept 1 to 1,024 bytes of visible ASCII
  (`0x21`-`0x7E`). That refuses control characters, spaces and non-ASCII, which keeps it a
  valid header value. A value that starts with `Bearer` gets "Paste the token without the
  word Bearer." Other refusals say "The token must be 1 to 1,024 visible ASCII characters
  with no spaces." No message ever contains the value. A string field cannot be echoed by
  serde's type errors.
- **Storage.** The token goes in `SecretStore` as `webhook-bearer-<endpoint id>`, next to
  `webhook-<id>`. A new column `webhook_endpoints.has_bearer_token INTEGER NOT NULL DEFAULT
  0` (the next migration number at merge) is the only thing the list and the sender read
  to learn that a token exists.
  - Setting: write the file, then set the flag.
  - Clearing: clear the flag, then remove the file.
  - A crash between the two steps leaves at worst a stray file with the flag off, which
    sends nothing.
  - Create: signing secret, then token, then row. If the insert fails, remove both, as
    `rpc.rs:315-316` does today.
  - Delete removes both files.
  - A failed token write answers `storage`. The other edits are already saved, and the
    message says "Its token was not changed. Try again."
- **Edits.** Setting, replacing or clearing the token is not a new revision. The
  destination and filters are unchanged, so the queue is kept and the next attempt reads
  the new token. A request already in flight finishes with the token it read.
- **Sending.** `delivery::Headers` gains `authorization: Option<&str>`, filled in
  `send_signed` (`mod.rs:436-466`). That function is the one path for queued deliveries,
  retries, redeliveries and test events, so all four carry the header. The header value is
  built with `HeaderValue::from_str` and `set_sensitive(true)`. If the flag is set but the
  file is missing or unreadable, the delivery fails as a new `Failure::TokenMissing`
  (`token_missing`). It is not retried and is never sent without the token, as with
  `secret_missing`. The HMAC is unchanged and does not cover `Authorization`.
- **Output.** `endpoint_view` and the `WebhookEndpoint` contract gain
  `bearerTokenSet: boolean`. `WebhookDelivery.lastError` documents `token_missing`.
- **Fixtures.** Webhooks have only typed-failure and manifest fixtures today
  (`fixtures/rpc-wire/typed-failures/webhooks__*.json`), so a new field regenerates
  nothing. Add three `contract-shapes/webhooks__upsert-*-request.json` fixtures (token
  absent, `null`, string) in `export-rust-rpc-fixtures.ts`. A Rust test decodes each
  through `UpsertInput` and asserts keep, clear and set.
- **Redaction.** The token is never in `endpoint_view`, the deliveries log (rows hold
  status and tag only), `tracing` fields, refusal text, profiler records (RPC timing
  records method names only), diagnostics bundles (logs and profiler data, never the
  secret store) or client state.
- **UI** (`WebhooksTab.tsx`). Add a **Bearer token** field (`type="password"`,
  `autoComplete="off"`).
  - Editing: the field is empty, with "A token is set" and **Replace** and **Remove**.
    Leaving it untouched omits `bearerToken`. **Remove** sends `null`.
  - After save, the field state is cleared and the value is never put in an atom or the
    query cache.
  - The form says the token is sent as `Authorization: Bearer` and never shown again.
- **Tests.**
  - `webhooks/tests.rs`: `a_bearer_token_is_sent_on_deliveries_retries_redeliveries_and_tests`,
    `a_bearer_token_is_never_listed_or_logged` (captures `tracing` output and checks
    `list` and `listDeliveries`), and `an_upsert_without_the_token_keeps_it_and_null_clears_it`.
  - New: `a_set_token_that_is_missing_fails_the_delivery_unsent`.
  - `rpc.rs` unit test: control characters, a space, over 1,024 bytes and a `Bearer `
    prefix are refused, and the message holds no part of the value.
  - The existing signature and `send_test_redeliver_rotate_and_delete` tests pass.
  - `WebhooksTab.test.tsx`: add, keep, replace and clear, masked after save, and absent
    from the DOM once saved.
- **Docs.**
  - `docs/reference/webhooks.md`: the upsert input (`:45`, `:51-66`), the endpoint example
    (`:80-96`), headers (`:207-214`), `token_missing` (`:284-285`, `:298-300`), edits
    (`:312-320`) and privacy (`:378-383`).
  - `docs/user/webhooks.md`.
  - `docs/testing/cross-platform-validation.md` step 13: the receiver also checks
    `Authorization`.
- **Bearer receiver preset (P2).** Dropped. With one token field there is nothing for a
  preset to fill.

### P1c: named clients (slice 3)

- **Persistence** (next migration):
  - `mcp_named_clients (client_id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT
    NOT NULL, revoked_at TEXT)`, with a unique index on `name WHERE revoked_at IS NULL`.
    The id is `nc_` plus a UUID, so it never collides with a session id.
  - `auth_sessions.mcp_named_client_id` and `auth_pairing_links.mcp_named_client_id`. The
    exchange copies it from link to session, as it copies `mcp_access`.
  - Revoked rows are kept (shortcut: never pruned; a person's revokes bound their number).
- **Relay.** `McpArgs` gains `--client <name>`. `mint` (`relay.rs:739-753`) runs
  `INSERT ... ON CONFLICT DO NOTHING` and then `SELECT` for the live row of that name, in
  one transaction under the existing store guard, so two relays starting at once get the
  same row. The label is `MCP · <name>`. EOF, signals and the orphan sweep revoke the
  session only, never the named client. A store without the table (a server older than
  the relay) exits 1 with "Update the BiBCode server to use --client".
- **Scope key.** `COALESCE(mcp_named_client_id, session_id)` replaces the three label
  `CASE` expressions. The CLI uses the reserved `bibcode-thread` named client. Shortcut: at
  upgrade, CLI retry rows from the previous 24 hours (`REQUEST_ROW_TTL_SECONDS`) stop
  matching. Upgrades restart the server anyway.
- **Actor.** `principal_actor` (`activity.rs:69-80`) uses the named id as `clientId`. The
  feed's `agent.call` actor (`feed.rs:396`) joins `auth_sessions` to do the same, and the
  activity row keeps its session id. `send_panel_message`'s ownership check
  (`panels.rs:410-415`) and its last-sender check compare against the caller's actor
  `clientId`, not `principal.session_id`. Webhook `actor.clientId` follows from that.
- **Pairing.** `pairedClientId` takes a session id. When that session has a named client,
  the endpoint stores the named id (the column keeps its name and gets a comment).
  `is_live_agent_session` (`store.rs:363`) and `orphaned_pairings` (`:344-359`) accept a
  live named client. `endpoint_view` adds `pairedClientName` so the picker can label an
  idle named client.
- **Revoke.** A person's **Revoke** and **Revoke others** (`AuthService::revoke_client`,
  `revoke_other_clients`; HTTP `/api/auth/clients/revoke*`) also revoke the session's named
  client and all of its live sessions. Its paired endpoints then turn off as
  `client-revoked`. The next `--client` run with that name creates a new identity, which a
  person pairs again.
- **Contract.** `AuthClientSession` gains `mcpNamedClient: optionalKey({ id, name })`, and
  `WebhookEndpoint` gains `pairedClientName: NullOr(String)`.
- **UI.** The Authorized clients row of a named client says "Keeps its identity across
  runs." The **Revoke** confirmation says that its paired webhooks turn off and its next
  run starts fresh. The Webhooks picker matches `mcpNamedClient.id ?? sessionId`.
- **Tests.**
  - `mcp_tools_tests/threads.rs`: `a_named_client_keeps_its_request_ids_across_runs`,
    `two_named_clients_do_not_share_request_ids`, and
    `an_unnamed_relay_with_the_same_client_info_name_does_not_join_a_named_scope`. Keep
    `only_bibcode_thread_credentials_share_their_client_request_ids`.
  - Panels: `a_named_client_still_owns_the_panels_it_opened_after_a_restart`.
  - `webhooks/tests.rs`: `an_endpoint_paired_with_a_named_client_survives_its_relay_exiting`
    and `a_person_revoking_a_named_clients_row_disables_its_endpoints_and_ends_every_run`.
    Keep `revoking_a_paired_client_disables_its_endpoints`. New:
    `an_endpoint_paired_with_an_unnamed_relay_turns_off_when_it_exits`, the current
    behavior, which no test covers yet.
  - `relay/tests.rs`: `the_relay_labels_a_named_client_and_still_revokes_on_eof` and
    `a_bad_client_name_exits_before_any_credential`.
  - A migration test for the new columns.
- **Docs.**
  - `docs/reference/mcp.md`: `:98-113`, `:172-202`, the credential (`:554-571`), retries
    (`:763-764`), actors (`:936-941`, `:1137`) and `send_panel_message` (`:1953`, `:1982`).
  - `docs/reference/webhooks.md:62-64`, `docs/user/mcp.md`, and the `bibcode-mcp` skill.
  - `docs/architecture/overview.md`, if it names the per-run identity.

### P1d: more `bibcode thread` subcommands (slice 4)

| Command                                                                | Tool                                               | Flags                                                                                |
| ---------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `requests <thread>` (added: there is no other way to get a request id) | `list_pending_requests`                            | none                                                                                 |
| `answer <thread> <request> <answers-json\|->`                          | `answer_question`                                  | `--request-id`, `--wait`                                                             |
| `approve <thread> <request> [--for-session]`                           | `answer_approval` (`accept` or `acceptForSession`) | `--request-id`, `--wait`                                                             |
| `decline <thread> <request> [--cancel]`                                | `answer_approval` (`decline` or `cancel`)          | `--request-id`, `--wait`                                                             |
| `interrupt <thread> [--turn <id>]`                                     | `interrupt_turn`                                   | none. The tool refuses a `clientRequestId` (`mcp.md:756-757`), so no `--request-id`. |
| `changes [--cursor <c>] [--thread <id>] [--limit <n>]`                 | `changes_since`                                    | none                                                                                 |

- `--wait` reuses the existing `wait_for_thread` loop. Sign-in, `--json` and exit codes 0,
  1 and 2 are the same as today. Usage errors already exit 1 (`main.rs:28-38`), so 2 stays
  unambiguous. Answers are never echoed or logged, like messages today.
- **Tests** (`thread_cli/tests.rs`): one case per subcommand with `--json` and its exit
  code. `answer` and `approve` are refused when **Agents may** is below the thread's mode.
  The CLI has no `--access`, so the test lowers the environment setting. `decline` is not
  ceiling-checked. `every_subcommand_and_flag_parses` is extended.
- **Docs.** The table at `docs/reference/mcp.md:172-202`, the `bibcode-mcp` skill, and
  step 7 of `docs/testing/cross-platform-validation.md` (review it).

### P2a: `bibcode mcp call` and `bibcode mcp tools` (slice 7)

- **Change.** Add them as subcommands of `bibcode mcp`, beside `authorize`
  (`config.rs:723-729`), rather than as top-level `call` and `tools`. That keeps the top
  level small and gives them `--access` and `--client`.
  - `call <tool> [<arguments-json>|-]` prints the tool result.
  - `tools` prints the tool list the credential sees.
  - Exit codes: 0 success; 1 a tool error, unknown tool or transport failure; 2 a result
    whose `status` is `awaiting_approval` or `awaiting_input`.
- **Tests.** In a new `mcp/call_cli` module: a read tool, a tool refused at the ceiling, and
  an unknown tool.
- **Docs.** `docs/reference/mcp.md` (transports) and the skill.

### P2b: remote OAuth with a hosted client (slice 8)

- **Change.** No server change is expected: `registrable_redirect_uri` already accepts
  `https` (`auth/oauth.rs:252-272`). Add **Copy URL** to the Remote agents row
  (`McpRemoteAgentsPanel.tsx:133-137`).
- **Tests.** `oauth_flow_tests.rs`: new
  `a_hosted_client_with_an_https_redirect_signs_in_and_refreshes` (register, authorize,
  approve, token, refresh, `/mcp`). `McpRemoteAgentsPanel.test.tsx` already exists: add a
  Copy URL case.
- **Docs.** `docs/reference/mcp.md:210-216`.

### P2c: requester in lists, purpose in the feed (slice 6)

- **Change.**
  - Move `summary["requester"] = ...` from `panels.rs:254` into `thread_summary`
    (`threads.rs:1593-1622`), so lists and panels share it.
  - `changes_since` `thread.created` and `panel.created` entries gain `purpose` when the
    creating event carries one.
  - Webhooks copy only `status`, `requestId`, `tool` and `target` (`events.rs:114`), so
    `purpose`, which is agent text, never reaches a payload.
- **Tests.** The `list_projects_and_threads` and `changes_since` cases in
  `production/mcp_tools_tests/`, plus a webhook payload check that `purpose` is absent.
- **Docs.** `docs/reference/mcp.md:1129-1138` and `:1267`.

### P2d: `projectId` in payloads, and a status-kind filter (slice 5)

- **Change.**
  - `Event::body` (`events.rs:66-79`) writes `projectId` when the route names one.
  - Endpoints gain `statusKinds: NullOr(Array(...))` over the five `thread.status_changed`
    kinds. `null` means all. `address` (`mod.rs:784-806`) skips a non-matching kind.
    Changing the list is a new revision, like `eventTypes`. It is persisted as a JSON
    column.
- **Tests.** `a_payload_holds_ids_and_states_only` checks `projectId`. New:
  `an_endpoint_that_skips_turn_started_gets_no_such_delivery`. Add the contract, a fixture
  and `WebhooksTab.test.tsx`.
- **Docs.** `docs/reference/webhooks.md:141-156`, `:51-66` and `:312-320`.

## Failure, restart, concurrency and security

- **Token limits.** 1,024 bytes of visible ASCII, validated before storage, so
  `HeaderValue::from_str` cannot fail at send time. If it does, the delivery fails as
  `token_missing`, never unauthenticated.
- **Keep and clear.** Absent keeps the token, `null` clears it and a string replaces it.
  The set and clear steps are ordered so that a crash never sends a stale token: at worst
  it sends none.
- **Retries.** A `401` or `403` from a wrong token is a non-retryable `4xx`, as today, and
  counts toward the ten-failure disable.
- **Named-client races.** Concurrent first runs of one name meet on the unique index. Two
  live runs share retries and panels, the trade-off the CLI scope already accepted for one
  operator (2026-10-24 `:1378-1382`).
- **Revoke and exit.**
  - A person's revoke ends the identity and every one of its runs, and it is durable in
    `mcp_named_clients.revoked_at`, so a missed notice is caught on the dispatcher's next
    pass (`reconcile_pairings`, `mod.rs:881-890`).
  - A relay's EOF, a signal or a crash revokes only that run's session.
  - A failed revoke on exit leaves the session live until the next sweep, as today.
- **Server restart.** Sessions and named clients are durable, and the relay rediscovers the
  server as before.
- **Trust.** `--client` needs data-root authority, which already lets its holder mint any
  credential, so a chosen name gains nothing new. Remote OAuth sessions cannot take a named
  client: only `mint` sets the column.

## Profiler, crash and trace coverage

- **Child processes.** None new. The CLI subcommands and `bibcode mcp call` are one-shot
  clients like `bibcode thread`.
- **RPC methods.** None new. `webhooks.upsert` is already timed through
  `register_unary`. The new CLI paths reach the server as MCP tool calls, timed as
  `mcp.<tool>`. `is_long_running` derives each tool's tier from its spec
  (`latency.rs:106-120`), and its test walks every tool.
- **Delivery header.** No span is added. A failed attempt keeps logging only the endpoint
  id, status and tag (`mod.rs:557-565`), and the new tag `token_missing` follows the same
  rule.
- **Logs and records.** No token, answer or purpose reaches `tracing`, `profiler::emit` or a
  finding. `a_bearer_token_is_never_listed_or_logged` enforces this for the token.
- **Not applicable.** Worktree removal, binaries and re-exec modes, shutdown order, and the
  profiler reference docs.

## Slices and order

1. **Slice 1** (may land before approval): P1a doc fix and P1b input events.
2. **Slice 2**: P0 bearer token.
3. **Slice 3**: P1c named clients, with the CLI folded in.
4. **Slice 4**: P1d CLI subcommands. Merge it after slice 3, because both touch
   `thread_cli.rs`.
5. **Slice 5**: P2d `projectId` and the status-kind filter (one webhooks contract change).
6. **Slice 6**: P2c requester and purpose.
7. **Slice 7**: P2a `bibcode mcp call` and `tools`. Merge it after slice 3 for `--client`.
8. **Slice 8**: P2b hosted OAuth test and **Copy URL**.

Every slice runs the gates listed in the issue. No `apps/desktop/e2e` spec covers webhooks
or MCP. Unit, flow and DOM tests cover each slice, so each PR says why no desktop spec is
added. UI slices (1, 2, 3, 5, 8) are reviewed against `UI.md` and the Vercel React
best-practices skill.

## Corrections to the issue

Everything else the issue marks measured was confirmed at `fd98b433068b`, including the
85-tool count (91 headings, 6 `terminal_*`) and version `0.14.0`.

- **"Inferred" claims are confirmed by the code** (still untested):
  - A new run loses panel ownership: `panels.rs:410-415` compares with
    `principal.session_id`.
  - A relay exit disables its paired endpoint: the relay sets `revoked_at`
    (`relay.rs:125`, `:658-669`), and the next dispatcher pass disables the endpoint through
    `orphaned_pairings` (`store.rs:344-359`, `mod.rs:881-890`).
- The label scope has **three** SQL copies, not two: `control.rs:1255`, `activity.rs:556`
  and `activity.rs:596`.
- The proposed label-keyed `MCP · <name>` collides with unnamed relays' labels
  (`relay.rs:541-554`).
- `interrupt_turn` takes no `clientRequestId` (`mcp.md:756-757`), so `--request-id` fits
  only `answer`, `approve` and `decline`. Shell agents also need `requests` to find a
  request id.
- `oauth_flow_tests.rs:515`, `:617` and `:748` are not registrations. Loopback redirects are
  registered at `:85` and `:1022` (`REDIRECT`, `:14`). The conclusion stands: no `https`
  redirect is registered.
- `McpRemoteAgentsPanel.test.tsx` already exists.
- Webhook fixtures are typed failures and the manifest only, so P0 must add contract-shape
  fixtures for anything to be regenerated.
- Line shifts:
  - `mcp.md:759-760` is `:763-764`.
  - The non-goal references `mcp.md:563-567` and `:625-627` are `:567-571` and `:642-644`.
  - `events.rs:208` is the test's `fn` line, and the `input.requested` row is `:222`.
- The bearer receiver preset (P2) is moot with one token field.
- `bibcode call` and `bibcode tools` fit better as `bibcode mcp call` and `bibcode mcp tools`.
- 2026-10-24 `:1381` says an agent named `bibcode thread` would join the CLI scope. The code
  labels agents `MCP · …` (`thread_cli.rs:20-22`), so it cannot.
