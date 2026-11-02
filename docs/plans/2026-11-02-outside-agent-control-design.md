# Outside Agent Control: Webhook Auth, Stable Identity, CLI

Status: Proposed 2026-11-02, awaiting Mauro's approval. Issue #271. Follows #139 and
amends one answer of the approved
[2026-10-24 MCP design](./2026-10-24-mcp-operate-server-design.md) (see
[Decision 2](#decision-2-a-stable-identity-across-runs)). Verified at `fd98b433068b`
(`main`, the merge of #241). Line references are to that commit.

**Revision 1 (2026-11-02)** answers the first Codex review. See
[Review findings and resolutions](#review-findings-and-resolutions). It changes two things:

- The bearer token is published in the same row update as the URL.
- **Named clients are split out of this batch.** Their decision stands, but building them
  touches auth, recorded outcomes, Stop and the UI's id joins. That is out of proportion
  next to the urgent P0, so they get their own issue, a re-review and a later release.

**Revision 2 (2026-11-02)** answers the second Codex review:

- Stray token files are removed per endpoint, under its edit mutex, with no startup
  sweep.
- Mixed client and server versions are specified.
- `answer`, `approve` and `decline` lose `--wait`.
- One-shot `bibcode mcp call` is limited to read-only tools other than `files_download`.

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
the alternative if Mauro prefers it. It needs a stored hint column and is still a partial
secret in client state.

### Decision 2: a stable identity across runs

**Recommended: a named client, built in a later release.** `bibcode mcp --client <name>`
attaches each run's credential to a durable, non-secret identity row. Retries, recorded
outcomes, panel ownership and webhook pairing key on that identity. Each run still mints
its own credential and revokes it on exit, and the orphan sweep still runs. No token is
stored.

**Until then**, an agent that restarts can leave its endpoint unpaired. An unpaired
endpoint is never turned off for its client (`docs/reference/webhooks.md:62-64`). It loses
only retries and panel ownership across runs, which is today's documented behavior.

| Option                                                               | For                                                                       | Against                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A named client row, opt-in with `--client`** (chosen)              | Durable identity with no bearer at rest. A person's Revoke still ends it. | One table and two columns, plus a scope helper on every keyed path, an actor field for Stop, and fenced session issuance (review findings 2 to 4). It is split to a later release.                                                                                                                                                                                                    |
| The label-keyed scope the issue proposes (`MCP · <name>` as the key) | No new table.                                                             | It collides: an unnamed relay is already labelled `MCP · <clientInfo.name>` (`relay.rs:541-554`), so `--client "Claude Code"` would share retries and panels with every unnamed Claude Code relay. A label cannot tell a relay that exited from a person's **Revoke**, so a paired endpoint must either survive both or die with both. It still needs a column to fix either problem. |
| A long-lived credential a person issues                              | One step, and works without the relay.                                    | It puts a live bearer at rest in the agent's config, which 2026-10-24 rejected (`:634-637`, and R2 at `:217-221`). It adds nothing locally: the relay already authenticates with data-root authority. Remote agents already keep one session for a grant's life, because a refresh reuses the session (`auth/service.rs:2162`).                                                       |
| Key every relay by `clientInfo.name`, with no flag                   | No flag to learn.                                                         | It merges every instance of one product (all Claude Code sessions). This is option (a) that 2026-10-24 rejected (`:1373-1374`).                                                                                                                                                                                                                                                       |

**This keeps the 2026-10-24 answer.** "Each launch mints, revokes on exit, and sweeps
orphans" still holds. The only change to "Nothing is stored" is a row holding a name and
dates, and it authenticates nothing. Authorized clients still shows one row per running
agent.

**The name comes from `--client` only.** `clientInfo.name` stays the label of unnamed runs.
Rules: 1 to 40 characters of `a-z 0-9 . _ -`, starting with a letter or digit. A bad name
exits 1 before any credential is minted.

**`bibcode thread` keeps its label scope.** Revision 0 folded it into a reserved named
client. That would need a migration of its retained request rows to keep the 24-hour
retry promise (`docs/reference/mcp.md:192-195`), and it buys nothing a user asked for. The
scope expression becomes "named client, else the CLI label, else the session"
([P1c](#p1c-named-clients-split-to-a-later-release)).

## Open questions

| Question (issue)                                                          | Recommendation                                                                                                                                                                                               | Needs Mauro?                                                                     |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Can Bridge verify `X-BibCode-Signature` or take a URL token?              | Build P0 either way. `Authorization` is the usual receiver contract, and a URL token is unmasked. Bridge should also verify the signature, which every request keeps.                                        | **Yes**: depends on Bridge's receiver. It sets P0's urgency, not its shape.      |
| One bearer, or custom headers? Hint?                                      | One bearer. `bearerTokenSet` only, with no hint ([Decision 1](#decision-1-the-webhook-auth-header)).                                                                                                         | Only if Bridge needs a non-`Authorization` header, or Mauro wants a last-4 hint. |
| `approvals` or a new `questions` category?                                | A new `questions` category, labelled **Questions**. A question is not an approval, and the feed names them apart (`input.*`).                                                                                | No                                                                               |
| Label scope or person-issued credential? `--client` or `clientInfo.name`? | A named client row, from `--client` only ([Decision 2](#decision-2-a-stable-identity-across-runs)), built in a later release.                                                                                | Approval of this note, and of the split                                          |
| Was leaving `projectId` out a privacy choice?                             | No reason is recorded. The X8 payload list never had it (`2026-10-30-mcp-remaining-slices-design.md`, Payload), and `events.rs:57` states only the fact. A project id is as opaque as `threadId`, so add it. | No                                                                               |
| Tags, or is `purpose` enough?                                             | `purpose` is enough. Add no tags until a concrete case needs one, such as a list filter by tag.                                                                                                              | **Yes**: ask Bridge for its case.                                                |
| Is the CLI's shared retry scope approved?                                 | Treat it as approved: it shipped, its test exists (`threads.rs:278`), and this note keeps it unchanged. Approving this note records that.                                                                    | **Yes** (approval of this note)                                                  |

## Requirements

Each item lists the change, the shapes, secret handling, tests, docs and its slice. "New"
test names are proposals. Contract and Rust shapes change together, and
`vp run check:contracts` runs in every slice that touches `packages/contracts`.

### P1a: stale retry paragraph (slice 1)

- **Change.** Rewrite `docs/reference/mcp.md:200-202`: `bibcode thread` runs share one
  `clientRequestId` scope (as `:192-195` says). Only `send_panel_message`'s "thread you
  opened or last drove" rule does not carry over between runs.
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
- **Mixed versions** (see [Mixed client and server versions](#mixed-client-and-server-versions)):
  - The capability is `webhookQuestionEvents`.
  - `WebhookEndpoint.eventTypes` decodes as strings, so a later event never breaks the
    list.
  - The form keeps event names it does not know when it saves.
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
- **Storage: the row names the token file.** Each token value gets a new file in
  `SecretStore`, `webhook-bearer-<endpoint id>-<32 hex>` (84 bytes, within the 128-byte
  name limit). A new nullable column `webhook_endpoints.bearer_secret` (the next migration
  number at merge) names the current file. That column is the only thing the list and the
  sender read. Because the URL and the token reference sit in one row, one commit
  publishes both, and no state pairs a destination with another destination's token.
  - **Set or replace:** write the new file, then commit the row. The commit stores the new
    name, together with any URL, filter or enabled change, in one transaction, and
    returns the name it replaced. Only after that commit is the replaced file removed.
  - **Clear:** commit `bearer_secret = NULL`, then remove the replaced file.
  - **A failed commit** removes the new file and answers `storage`. Nothing changed: the
    old URL and old token stay paired.
  - **A crash** before the commit, or before the replaced file is removed, leaves an
    unreferenced file. There is no startup sweep, because one would race a save
    (`Webhooks::start` spawns its task without awaiting it, `mod.rs:241`). Instead, every
    upsert and delete of an endpoint, while holding that endpoint's edit mutex, lists
    `SecretStore::names()` (`secret_store.rs:279`). It removes each
    `webhook-bearer-<that id>-*` file that the row does not name, other than the file this
    edit just wrote. Delete removes all of them. So only the one edit that owns an
    endpoint's prefix ever removes its files. Shortcut: a stray file of an endpoint that is
    never edited again stays until the endpoint is deleted. It names no destination and
    has the secret store's protection.
  - **Create:** signing secret, token file, then row. If the insert fails, remove both, as
    `rpc.rs:315-316` does today. Delete removes the signing secret and the named file.
  - **One edit at a time per endpoint.** Every upsert and delete of an endpoint takes a
    per-endpoint edit mutex before it reads the endpoint (`rpc.rs:254`) and validates the
    URL and token, and holds it through the file write, the row commit and the removal of
    the replaced file. So the "URL unchanged" check and the row it writes always see the
    same stored URL and token, and a rename that read URL A cannot commit after another
    edit moved the endpoint to URL B with token B. Test:
    `a_rename_racing_a_url_and_token_change_never_pairs_the_old_url_with_the_new_token`.
    `update_endpoint` writes `bearer_secret` only when the upsert carries `bearerToken`,
    so a rename can never write back a reference it read earlier. One server process owns
    the store, so an in-process mutex is enough.
  - **A replaced file is removed under the endpoint's send lock,** waited for and not
    cancelled. Senders read the row and then the file while holding that lock
    (`mod.rs:496-509`, `rpc.rs:462-464`), so no sender reads a reference whose file is
    then removed.
- **A URL change must restate the token.** If an endpoint has a token and an upsert changes
  its URL without `bearerToken`, the upsert is refused (`invalid`): "Enter the token for
  the new URL, or remove it." Keeping the token would send receiver A's credential to
  receiver B. The form asks for this as soon as the URL is edited.
- **Edits.** A token change without a URL change is not a new revision. The destination
  and filters are unchanged, so the queue is kept and the next attempt reads the new
  token. A URL change is already a new revision (`rpc.rs:267-270`), which runs under
  `under_send_lock`: it cancels the request in flight and abandons the old queue.
- **Sending.** `delivery::Headers` gains `authorization: Option<&str>`, filled in
  `send_signed` (`mod.rs:436-466`) from the `bearer_secret` of the row the sender read.
  That function is the one path for queued deliveries, retries, redeliveries and test
  events, so all four carry the header. The header value is built with
  `HeaderValue::from_str` and `set_sensitive(true)`. If the row names a file that cannot
  be read, the delivery fails as a new `Failure::TokenMissing` (`token_missing`). It is
  not retried and is never sent without the token, as with `secret_missing`. The HMAC is
  unchanged and does not cover `Authorization`.
- **Output.** `endpoint_view` and the `WebhookEndpoint` contract gain
  `bearerTokenSet: boolean` (`bearer_secret IS NOT NULL`), which decodes to `false` when
  absent. `WebhookDelivery.lastError` documents `token_missing`. The capability is
  `webhookBearerToken`. Without it the form hides the field and says "Update BiBCode on
  this environment to send a bearer token."
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
    Leaving it untouched omits `bearerToken`. **Remove** sends `null`. Editing the URL of
    an endpoint with a token opens the field and says "Enter the token for the new URL, or
    remove it." Save stays disabled, with that reason, until one is chosen.
  - After save, the field state is cleared and the value is never put in an atom or the
    query cache.
  - The form says the token is sent as `Authorization: Bearer` and never shown again.
- **Tests.**
  - `webhooks/tests.rs`: `a_bearer_token_is_sent_on_deliveries_retries_redeliveries_and_tests`,
    `a_bearer_token_is_never_listed_or_logged` (captures `tracing` output and checks
    `list` and `listDeliveries`), and `an_upsert_without_the_token_keeps_it_and_null_clears_it`.
  - New: `a_set_token_that_is_missing_fails_the_delivery_unsent`.
  - New: `a_failed_commit_of_a_url_and_token_change_keeps_the_old_url_with_the_old_token`.
    It injects a store failure into the row commit, then checks that receiver A gets only
    token A and receiver B gets nothing.
  - New: `a_url_change_without_the_token_is_refused_while_one_is_set`.
  - New: `a_token_file_left_by_a_crash_is_removed_by_the_next_edit_and_never_sent`. It
    writes the file, skips the commit, restarts, then edits.
  - New: `a_save_during_dispatcher_start_keeps_its_token`. A pause hook holds the
    dispatcher's start while an upsert writes its file and commits. No delivery fails as
    `token_missing`.
  - New: `concurrent_clear_and_replace_leave_a_readable_token_or_none`. Pause hooks hold one
    upsert after its file write while the other commits, in both orders. The row then
    names a readable file or none, and no delivery fails as `token_missing`.
  - New: `a_replaced_token_file_is_not_removed_under_a_sender_that_read_it`. A pause hook
    holds a sender after its row read.
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

### P1c: named clients (split to a later release)

**Not in this batch.** This is the design the split-off issue starts from. It must be
re-reviewed before any code. Revision 1 adds the parts the first review found missing
(findings 2 to 4), and they are why it is split: each touches a separate owner (auth,
recorded outcomes, Stop, the UI).

- **Persistence** (next migration):
  - `mcp_named_clients (client_id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT
    NOT NULL, revoked_at TEXT)`, with a unique index on `name WHERE revoked_at IS NULL`.
    The id is `nc_` plus a UUID, so it never collides with a session id.
  - `auth_sessions.mcp_named_client_id` and `auth_pairing_links.mcp_named_client_id`.
  - Revoked rows are kept (shortcut: never pruned; a person's revokes bound their number).
- **Relay.** `McpArgs` gains `--client <name>`. `mint` (`relay.rs:739-753`) runs
  `INSERT ... ON CONFLICT DO NOTHING` and then `SELECT` for the live row of that name, in
  one transaction under the existing store guard. The label is `MCP · <name>`. EOF, signals
  and the orphan sweep revoke the session only. A store without the table exits 1 with
  "Update the BiBCode server to use --client".
- **Fencing a run against revocation.** The link is minted (`relay.rs:739-753`), the grant
  is consumed (`consume_grant`, `auth/service.rs:2781`), and the session is inserted
  (`create_auth_session`, `:2751`) in separate steps. A person's revoke can land between
  any two of them.
  - Revoking a named client revokes its unconsumed pairing links and its live sessions in
    the same transaction that sets `revoked_at`.
  - The session insert for a link that carries a named id is
    `INSERT ... SELECT ... WHERE EXISTS (SELECT 1 FROM mcp_named_clients WHERE client_id =
    ? AND revoked_at IS NULL)`. Zero rows fails the exchange as `invalid_grant`, and the
    relay reports `McpSignInError`.
  - Tests: `a_named_client_revoked_before_its_link_is_consumed_gets_no_session` and
    `a_named_client_revoked_after_consumption_but_before_the_session_insert_gets_no_session`,
    each with a pause hook at that step.
- **One scope, every keyed path.** One helper, `request_scope(session_id)`, returns the
  named id, else the CLI label (unchanged), else the session. The scope must be applied
  everywhere a `clientRequestId` is keyed:
  - `stored_request` (`control.rs:1255`) and both `activity.rs` queries (`:556`, `:596`);
  - the recorded outcomes in `mcp/outcome.rs`: `read_row` (`:624-640`) and
    `insert_running`, which use `RequestKey.session_id` directly today;
  - the in-process claim map (`outcome.rs:603-621`), so two live runs of one name share
    one claim.
  - `RequestKey` gains `scope` beside `session_id`. Cancellation, the live controls and
    Stop stay keyed by the session.
  - Tests: `a_named_agent_retrying_git_undo_commit_after_a_restart_replays_the_recorded_outcome`
    (it must not undo a second commit), `two_live_runs_of_one_named_client_share_one_claim`,
    `a_named_client_keeps_its_request_ids_across_runs`,
    `two_named_clients_do_not_share_request_ids`, and
    `an_unnamed_relay_with_the_same_client_info_name_does_not_join_a_named_scope`. Keep
    `only_bibcode_thread_credentials_share_their_client_request_ids`.
- **Actor: `clientId` keeps meaning the session.** Revision 0 changed `clientId` to the
  named id. That breaks Stop: the handler gets the session (`auth/service.rs:2004`) and
  matches `actor_json.clientId` (`activity.rs:754-766`). It also breaks the UI joins on
  `sessionId === clientId` (`McpAgentsPanel.tsx:110`, `McpAgentIndicator.tsx:26`).
  Instead, the actor gains an optional `namedClientId`, written by `principal_actor`
  (`activity.rs:69-80`) and by the feed's `agent.call` row (`feed.rs:396`, through a join).
  - `send_panel_message` ownership (`panels.rs:410-415`) and its last-sender check accept
    the same session, or the same `namedClientId`.
  - **Stop** on a named client's row interrupts turns whose actor `clientId` is that
    session, or whose `namedClientId` is its named client. That covers turns started by an
    earlier run that has exited.
  - The UI joins are unchanged. `redacted_actor` (`events.rs`) also passes an id-shaped
    `namedClientId`.
  - Tests: `stop_on_a_named_clients_row_interrupts_turns_of_its_earlier_run_after_the_relay_exited`,
    `stop_on_an_unnamed_session_is_unchanged`, and
    `a_named_client_still_owns_the_panels_it_opened_after_a_restart`.
- **Pairing.** `pairedClientId` takes a session id. When that session has a named client,
  the endpoint stores the named id. `is_live_agent_session` (`store.rs:363`) and
  `orphaned_pairings` (`:344-359`) accept a live named client. `endpoint_view` adds
  `pairedClientName`.
- **Revoke.** A person's **Revoke** and **Revoke others** (`AuthService::revoke_client`,
  `revoke_other_clients`) also revoke the named client, as above. Its paired endpoints
  turn off as `client-revoked`. The next `--client` run with that name creates a new
  identity.
- **Contract and UI.** `AuthClientSession` gains `mcpNamedClient: optionalKey({ id, name })`.
  `WebhookEndpoint` gains `pairedClientName`, and the actor gains `namedClientId`. The
  Authorized clients row says "Keeps its identity across runs", and **Revoke** says that
  its paired webhooks turn off and its next run starts fresh.
- **Other tests.**
  - `webhooks/tests.rs`: `an_endpoint_paired_with_a_named_client_survives_its_relay_exiting`,
    `a_person_revoking_a_named_clients_row_disables_its_endpoints_and_ends_every_run`, and
    `an_endpoint_paired_with_an_unnamed_relay_turns_off_when_it_exits`. Keep
    `revoking_a_paired_client_disables_its_endpoints`.
  - `relay/tests.rs`: `the_relay_labels_a_named_client_and_still_revokes_on_eof` and
    `a_bad_client_name_exits_before_any_credential`.
  - A migration test.
- **Docs.** `docs/reference/mcp.md` (`:98-113`, `:172-202`, `:554-571`, `:763-764`,
  `:936-941`, `:1137`, `:1953`, `:1982`), `docs/reference/webhooks.md:62-64`,
  `docs/user/mcp.md` and the `bibcode-mcp` skill.

### P1d: more `bibcode thread` subcommands (slice 3)

| Command                                                                | Tool                                               | Flags                                                                                |
| ---------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `requests <thread>` (added: there is no other way to get a request id) | `list_pending_requests`                            | none                                                                                 |
| `answer <thread> <request> <answers-json\|->`                          | `answer_question`                                  | `--request-id`                                                                       |
| `approve <thread> <request> [--for-session]`                           | `answer_approval` (`accept` or `acceptForSession`) | `--request-id`                                                                       |
| `decline <thread> <request> [--cancel]`                                | `answer_approval` (`decline` or `cancel`)          | `--request-id`                                                                       |
| `interrupt <thread> [--turn <id>]`                                     | `interrupt_turn`                                   | none. The tool refuses a `clientRequestId` (`mcp.md:756-757`), so no `--request-id`. |
| `changes [--cursor <c>] [--thread <id>] [--limit <n>]`                 | `changes_since`                                    | none                                                                                 |

- **No `--wait` on `answer`, `approve` or `decline`** (restricted).
  - `wait_for_thread` stops at once on `awaiting_input` or `awaiting_approval`
    (`mcp/wait.rs:49-55`), and the answer's resolution is projected later. So a wait right
    after an answer can report the request just answered.
  - A correct wait needs a fence on that request's resolution and the answered turn's id.
    `wait_for_thread` takes neither today (`:75`). That is a server change for a
    convenience, so it is left out. Watch the thread with `bibcode thread show`, or the
    `input.resolved` and `approval.resolved` webhooks.
- Sign-in, `--json` and exit codes 0, 1 and 2 are the same as today. Usage errors already exit 1 (`main.rs:28-38`), so 2 stays
  unambiguous. Answers are never echoed or logged, like messages today.
- **Tests** (`thread_cli/tests.rs`): one case per subcommand with `--json` and its exit
  code. `answer` and `approve` are refused when **Agents may** is below the thread's mode.
  The CLI has no `--access`, so the test lowers the environment setting. `decline` is not
  ceiling-checked. `every_subcommand_and_flag_parses` is extended.
- **Docs.** The table at `docs/reference/mcp.md:172-202`, the `bibcode-mcp` skill, and
  step 7 of `docs/testing/cross-platform-validation.md` (review it).

### P2a: `bibcode mcp call` and `bibcode mcp tools` (slice 6)

- **Change.** Add them as subcommands of `bibcode mcp`, beside `authorize`
  (`config.rs:723-729`), rather than as top-level `call` and `tools`. That keeps the top
  level small and gives them `--access`, and `--client` once named clients ship.
  - `call <tool> [<arguments-json>|-]` prints the tool result.
  - `tools` prints the tool list the credential sees, each with `oneShot: true|false`.
  - Exit codes: 0 success; 1 a tool error, unknown tool or transport failure; 2 a result
    whose `status` is `awaiting_approval` or `awaiting_input`.
- **Restricted to read-only tools, except `files_download`.**
  - A one-shot run revokes its credential on exit. That ends what the call handed back:
    a transfer URL is checked against its minting session (`controls_for`,
    `production/transfer_routes.rs:76-92`), and owned work such as a running clone stops
    (`mcp.md:918-929`).
  - Read-only tools (`ToolSpec.read_only`) finish within the call. `files_download` is the
    one read-only tool that hands back a session-bound URL.
  - Every other tool is refused before any credential is minted: "`<tool>` needs a
    connection that stays open. Use it from `bibcode mcp` in your agent, or `bibcode
    thread` for messages, answers and approvals."
  - Widening this needs a per-tool "finishes within the call" flag on `ToolSpec`, which is
    a later choice.
- **Tests.** In a new `mcp/call_cli` module: a read tool, a tool refused at the ceiling, an
  unknown tool, and `files_download`, `files_upload` and `clone_repository` refused with
  no credential minted.
- **Docs.** `docs/reference/mcp.md` (transports) and the skill.

### P2b: remote OAuth with a hosted client (slice 7)

- **Change.** No server change is expected: `registrable_redirect_uri` already accepts
  `https` (`auth/oauth.rs:252-272`). Add **Copy URL** to the Remote agents row
  (`McpRemoteAgentsPanel.tsx:133-137`).
- **Tests.** `oauth_flow_tests.rs`: new
  `a_hosted_client_with_an_https_redirect_signs_in_and_refreshes` (register, authorize,
  approve, token, refresh, `/mcp`). `McpRemoteAgentsPanel.test.tsx` already exists: add a
  Copy URL case.
- **Docs.** `docs/reference/mcp.md:210-216`.

### P2c: requester in lists, purpose in the feed (slice 5)

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

### P2d: `projectId` in payloads, and a status-kind filter (slice 4)

- **Change.**
  - `Event::body` (`events.rs:66-79`) writes `projectId` when the route names one.
  - Endpoints gain `statusKinds: NullOr(Array(...))` over the five `thread.status_changed`
    kinds. `null` means all. `address` (`mod.rs:784-806`) skips a non-matching kind.
    Changing the list is a new revision, like `eventTypes`. It is persisted as a JSON
    column.
  - On input, `statusKinds` absent keeps the stored filter, so an older client's save
    never resets it. On output, absent decodes to `null`. The capability is
    `webhookStatusKinds`.
- **Tests.** `a_payload_holds_ids_and_states_only` checks `projectId`. New:
  `an_endpoint_that_skips_turn_started_gets_no_such_delivery`. Add the contract, a fixture
  and `WebhooksTab.test.tsx`.
- **Docs.** `docs/reference/webhooks.md:141-156`, `:51-66` and `:312-320`.

## Mixed client and server versions

A desktop app often reaches an environment that runs another BiBCode version. Both sides
advertise the same remote protocol (`REMOTE_PROTOCOL_VERSION` is 1). The existing answer is
`ExecutionEnvironmentCapabilities`: booleans that decode to `false` when absent
(`packages/contracts/src/environment.ts:29-60`), set by the server's descriptor
(`production/control.rs:2697-2706`). This note uses that mechanism and adds nothing new.

- **New client, older server.**
  - The capabilities `webhookQuestionEvents` (slice 1), `webhookBearerToken` (slice 2)
    and `webhookStatusKinds` (slice 4) read `false`, so the form hides that control with
    "Update BiBCode on this environment to ...".
  - New output fields have decoding defaults: `bearerTokenSet` is `false` and
    `statusKinds` is `null`. An older server's `webhooks.list` result still decodes.
  - The client never sends `bearerToken` or `statusKinds` to a server without the
    capability. If it did, `deny_unknown_fields` (`rpc.rs:137`) would refuse it as
    `invalid`, never ignore it silently.
- **Older client, newer server.**
  - An upsert without `bearerToken` or `statusKinds` keeps both. An older client's save
    never clears a token or resets a filter.
  - Effect `Struct` ignores fields it does not know, so new output fields are harmless.
  - The closed event enum is not. A v0.14 client fails to decode `webhooks.list` once an
    endpoint subscribes to a question event, because `WebhookEndpoint.eventTypes` is
    `Array(WebhookEventType)` (`webhooks.ts:60`). Its Webhooks tab shows a load error. It
    fails closed and loses nothing, but it can neither list nor edit endpoints.
  - **Known limit.** A server cannot tell which version a client runs (no client version
    is sent), and hiding events from the list would make an old client's save drop them.
    The fix is to update the app.
  - From slice 1 on, `eventTypes` decodes as `Array(String)` and the form saves back the
    names it does not know. Later events then never break a client.
- **Tests, both directions.**
  - Contract tests decode older-server fixtures, without the new fields, into the new
    schema.
  - `WebhooksTab.test.tsx` hides each control when its capability is `false`.
  - A Rust test checks that an upsert in the v0.14 shape keeps the token and the filter.
  - A contract test decodes a list with an unknown event type and preserves it.

## Failure, restart, concurrency and security

- **Token limits.** 1,024 bytes of visible ASCII, validated before storage, so
  `HeaderValue::from_str` cannot fail at send time. If it does, the delivery fails as
  `token_missing`, never unauthenticated.
- **Keep and clear.** Absent keeps the token, `null` clears it and a string replaces it.
  A URL change must restate it.
- **Crossing receivers.** The URL and the token reference change in one row commit. A
  failed commit, or a crash before it, leaves the old URL with the old token. A crash
  after it leaves only an unreferenced file, which the endpoint's next edit removes.
- **Mixed versions.** Every new output field has a decoding default. Every new control is
  gated on an environment capability. An upsert from an older client keeps what it does
  not name. See [Mixed client and server versions](#mixed-client-and-server-versions).
- **Concurrent edits.** A per-endpoint edit mutex orders upserts. A replaced file is
  removed only after its replacement is committed, and under the send lock, so the row
  always names a readable file or none.
- **Retries.** A `401` or `403` from a wrong token is a non-retryable `4xx`, as today, and
  counts toward the ten-failure disable.
- **Named clients.** Their concurrency, revoke, Stop and restart rules are in
  [P1c](#p1c-named-clients-split-to-a-later-release), for the later release. Nothing in
  this batch changes credential minting, revocation or the 2026-10-24 per-launch rule.

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
3. **Slice 3**: P1d CLI subcommands.
4. **Slice 4**: P2d `projectId` and the status-kind filter (one webhooks contract change).
5. **Slice 5**: P2c requester and purpose.
6. **Slice 6**: P2a `bibcode mcp call` and `tools`.
7. **Slice 7**: P2b hosted OAuth test and **Copy URL**.
8. **Later release, own issue**: P1c named clients, after a re-review of its section.

Every slice runs the gates listed in the issue. No `apps/desktop/e2e` spec covers webhooks
or MCP. Unit, flow and DOM tests cover each slice, so each PR says why no desktop spec is
added. UI slices (1, 2, 4, 7) are reviewed against `UI.md` and the Vercel React
best-practices skill.

## Review findings and resolutions

Codex review, round 1, of revision 0. Each finding was checked against the source at
`fd98b433068b` before it was accepted. None was refuted.

| #   | Finding                                                                                                                                    | Checked in source                                                                                                                                                                                                                 | Resolution                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | P1: a failed token write after the endpoint edit commits can send token A to new receiver B.                                               | Confirmed. `upsert` commits the row in `update_endpoint` (`rpc.rs:281`), separately from any secret write.                                                                                                                        | **Fixed (P0).** Each token value is its own file, and the row's `bearer_secret` names it, so the URL and the token change in one commit. A URL change must restate the token. Tests cover a failed commit and a crash before it.                                                            |
| 2   | P1: recorded outcomes key on the session, so a named agent retrying `git_undo_commit` after a restart would undo another commit.           | Confirmed. `outcome.rs` `claim` (`:603-621`) and `read_row` (`:624-640`) use `RequestKey.session_id` directly. Only `stored_request` and the `activity.rs` reads apply the label rule.                                            | **Fixed in P1c, which is split.** One `request_scope` covers stored requests, recorded outcomes and the claim map. Cancellation stays per session. Tests are named.                                                                                                                         |
| 3   | P1: a named `clientId` breaks Stop and the UI joins.                                                                                       | Confirmed. Stop passes the session (`auth/service.rs:2004`), running turns match `actor_json.clientId` (`activity.rs:754-766`), and the UI joins `sessionId === clientId` (`McpAgentsPanel.tsx:110`, `McpAgentIndicator.tsx:26`). | **Fixed in P1c, which is split.** `clientId` keeps meaning the session. A new optional `actor.namedClientId` carries the identity. Stop matches either, including turns of an earlier run that has exited. Tests are named.                                                                 |
| 4   | P2: a revoke races a run between link mint, grant consumption and session insert.                                                          | Confirmed. `consume_grant` (`auth/service.rs:2781`) and `create_auth_session` (`:2751`) are separate steps.                                                                                                                       | **Fixed in P1c, which is split.** A revoke also revokes the named client's unconsumed links. The session insert is conditional on the named client being live. There is a test before and a test after consumption.                                                                         |
| 5   | P2: a concurrent clear and replace can leave the flag set with no file, which gives `token_missing` failures and then a disabled endpoint. | Confirmed for revision 0's flag and fixed file name. A whole-row `update_endpoint` could also write back a stale value.                                                                                                           | **Fixed (P0).** There is no separate flag: the row names the file. A per-endpoint edit mutex orders edits. `update_endpoint` touches `bearer_secret` only when a token is given. A replaced file is removed after the commit, under the send lock. A controlled-interleaving test is named. |
| 6   | P2: folding the CLI into a reserved identity breaks the 24-hour retry promise at upgrade.                                                  | Confirmed. The rows are keyed `CLI · bibcode thread` (`control.rs:1255`), and `docs/reference/mcp.md:192-195` promises 24 hours.                                                                                                  | **Removed.** The CLI keeps its label scope, so no rows move and nothing needs migrating. This is the smaller design.                                                                                                                                                                        |

Codex review, round 2, of revision 1. Each finding was checked against the source. None
was refuted. Two are resolved by restricting a slice, the smaller correct design.

| #    | Finding                                                                                                   | Checked in source                                                                                                                                                      | Resolution                                                                                                                                                                                                                                                                                                                                 |
| ---- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R2.1 | P2: a startup sweep races a token save, and the cited prune helper's predicate reads contents, not names. | Confirmed. `Webhooks::start` spawns `run` without awaiting it (`mod.rs:241`). `prune_records_with_prefix` takes `Fn(&[u8])` over contents (`secret_store.rs:302-308`). | **Fixed (P0).** No startup sweep. Each edit of an endpoint removes that endpoint's unreferenced files under its own edit mutex, using `SecretStore::names()`. Tests cover a stray file after a crash, and a save during dispatcher start.                                                                                                  |
| R2.2 | P2: mixed versions. New fields are required, and the event enum is closed.                                | Confirmed. `WebhookEndpoint` fields are required (`webhooks.ts:55-75`). `eventTypes` is a closed enum (`:60`). There is no client version signal.                      | **Fixed, with one documented limit.** Capability flags and decoding defaults follow the existing pattern, and absent input fields keep stored values. `eventTypes` decodes as strings from slice 1 on. A v0.14 client fails closed on question events. Tests run in both directions ([Mixed versions](#mixed-client-and-server-versions)). |
| R2.3 | P2: `answer --wait` can return `awaiting_input` for the question just answered.                           | Confirmed. `done()` stops on `awaiting_input` (`mcp/wait.rs:49-55`), and `wait_for_thread` takes only `threadId`, `messageId` and `timeoutMs` (`:74`).                 | **Restricted.** `--wait` is dropped from `answer`, `approve` and `decline`. A fenced wait needs a server change for a convenience.                                                                                                                                                                                                         |
| R2.4 | P2: `bibcode mcp call files_download` prints a URL that dies when the run exits.                          | Confirmed. `controls_for` refuses a session that ended (`transfer_routes.rs:76-92`). Owned work such as a clone also stops on revoke (`mcp.md:919-929`).               | **Restricted.** One-shot `call` accepts read-only tools except `files_download`, and refuses every other tool before minting. `tools` marks `oneShot`. Tests are named.                                                                                                                                                                    |

Round 3 (final, REVISE): P1, a rename that read URL A could commit after another edit moved the endpoint to URL B with token B, pairing A with B's token. Confirmed: the endpoint is read before the edit mutex (`rpc.rs:254`) and the supplied URL is written later (`store.rs:283`). **Fixed:** the edit mutex is taken before the read and validation and held through cleanup ("One edit at a time per endpoint"), with a named interleaving test.

**Proportion (round 1).** Round 1 findings 2 to 4 show that named clients reach into auth issuance, recorded
outcomes, Stop and two UI joins. Next to the urgent P0, that is disproportionate. They are
split into their own issue and a later release (see the status note). Every other item
stays in this batch.

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
