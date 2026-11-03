# MCP Relay: Revoking a Credential Whose Token Response Was Lost

Status: Approved by the maintainer 2026-11-03 (revision 2). Issue #281. Verified at `30622da46436` (`v015/batch`). Line
references are to that commit. No product code is written until this design is approved.

**Revision 1 (2026-11-03)** answers the first Codex review (REVISE, five P2 findings). See
[Review findings and resolutions](#review-findings-and-resolutions). The changes:

- Unconfirmed records get a name older sweeps never read.
- Records are published atomically, and sign-in stops if a record cannot be written.
- The authority watcher also reloads after a local publication.
- The crash test runs the sweep itself.

**Revision 2 (2026-11-03)** answers the second Codex review. All five round-1 findings
were accepted as resolved, and it raised two new P2 findings:

- A sweep skips a record it cannot read, rather than fencing it.
- On an older server the session id stays tracked for cleanup at exit.

## Outcome

A credential an MCP relay (`bibcode mcp`, `bibcode thread …`, `bibcode mcp call`) asked
for is revoked when the relay ends, and by the next relay's orphan sweep when its process
died, even if the `/oauth/token` response never arrived. One session per link, the 60 s
link lifetime, and "no token in logs or client records" still hold.

## What the code does today (verified)

| Area            | Behaviour at `30622da46436`                                                                                                                                                                                                                                                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in order   | `Connection::token` (`mcp/relay.rs:637-697`) runs on its own task: `mint` (`:651`), `POST /oauth/token` (`:652-666`), status check (`:667`), body read (`:678-681`), `sid` from the token (`:686`), then `record_client` (`:688`) and the slot (`:689`). Any `?` before `:688` returns with nothing recorded.                                         |
| Mint            | `mint` (`:784-798`) calls `issue_mcp_pairing_link` and keeps only `issued.credential`; the link `id` it returns (`auth/service.rs:3549-3554`) is dropped.                                                                                                                                                                                             |
| Link            | `issue_mcp_pairing_link` (`auth/service.rs:3498-3555`): a random UUID `id`, subject `mcp-client`, label `MCP · <clientInfo name>`, TTL `MCP_PAIRING_TTL_MS` = 60 s (`:62`).                                                                                                                                                                           |
| Exchange        | `exchange_bootstrap_with_delivery` (`:955-976`): `consume_grant` (`:2800-2852`) commits the consume in one transaction (`persistence/repositories.rs:2242-2266`); `issue_session` (`:2675-2798`) then picks a fresh `Uuid::new_v4()` session id (`:2703`) and commits the row in a second transaction (`:2768-2773`, `repositories.rs:2319-2330`).    |
| TTL             | `SESSION_TTL_MS` is 30 days (`auth/service.rs:43`).                                                                                                                                                                                                                                                                                                   |
| Revoke          | `Connection::revoke` (`relay.rs:700-711`) takes the slot (waiting for a running sign-in) and returns early when it is empty. `revoke_sessions` (`:800-815`) calls `revoke_auth_session`, which is `Ok(false)` for an unknown id (`repositories.rs:2373-2398`).                                                                                        |
| Orphan sweep    | `sweep_orphans` (`relay.rs:818-859`) lists `<state>/mcp-clients/<session id>.json`, keeps records whose `pid` and `processStartedAt` still match, and revokes the rest by file stem.                                                                                                                                                                  |
| Linking columns | `auth_sessions` (migration 31, `migrations.rs:1932-1947`, plus later `reach`, `off_host`, `delivery_state`, `mcp_access`, `mcp_access_hand_back`, `mcp_resource`) has no pairing-link id. `client_label` is copied from the link label (`apply_grant_label`, `service.rs:3352`), and many relays share one label. Nothing ties a session to its link. |
| Link revoke     | `revoke_auth_pairing_link` (`repositories.rs:2273-2301`) touches only unconsumed links.                                                                                                                                                                                                                                                               |
| Migrations      | The newest is 68 (`migrations.rs:669`), so the next free id is 69. A binary refuses a store whose ledger is not a prefix of its own (`:183-193`).                                                                                                                                                                                                     |
| Existing test   | `a_sign_in_dropped_after_the_server_made_the_session_is_still_revoked` (`mcp/relay/tests.rs:165`) covers the Ctrl-C case from #271 with the `hold_after_sign_in` hook.                                                                                                                                                                                |

## Decision: how the relay finds a session it never heard about

| Option                                                                                                                                                                                          | For                                                                                                                                                                                                                                                                 | Against                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a)** `auth_sessions.pairing_link_id` (migration 69). The relay records the link id before the exchange. Revoke and the sweep revoke "every session exchanged from link X".                   | Explicit, works for every grant kind.                                                                                                                                                                                                                               | A migration, a column, an index and a repository query. The record format must change (a `linkId` field), because an older relay's sweep would revoke the file stem as a session id and leak silently. A v0.14 binary cannot open the store, as with every v0.15 migration. |
| **(b) recommended:** **the session id of an `mcp-client` grant is its link id.** The relay records `<link id>.json` before the exchange. Revoke and the sweep revoke that id, as they do today. | No migration, no column, no new query. The record contents and the sweep lookup are unchanged. Only the unconfirmed record gets a name older sweeps skip (R1.1). `session_id` is the primary key, so a second session for one link is impossible even in principle. | It couples two ids. A link id is not a secret: the credential is. Both ids are already shown only to owners (Authorized clients, pairing list events). It is limited to `mcp-client` grants, so remote, offer and pending-pairing flows are unchanged.                      |
| (b2) Find sessions by label                                                                                                                                                                     | No server change.                                                                                                                                                                                                                                                   | The label `MCP · <name>` is shared by every relay of one agent (`relay.rs:566-580`). It would revoke live relays. Rejected.                                                                                                                                                 |
| (b3) Match the link's `consumed_at` to the session's `issued_at`                                                                                                                                | No schema change.                                                                                                                                                                                                                                                   | Timestamps are not unique under concurrent relays. Rejected.                                                                                                                                                                                                                |

Both (a) and (b) need the same fence for a revoke that lands between the consume and the
insert (see below). The fence is what makes either one correct. (b) only removes the
lookup.

## Design (option b)

**Server (`auth/service.rs`, `persistence/repositories.rs`).**

- `Grant` gains `pairing_id: Option<String>`, filled by `consume_grant` from the consumed
  row. `issue_session_from_grant` uses it as the session id when `grant.subject ==
  MCP_CLIENT_SUBJECT`, else a new UUID as today.
- For such a grant, `create_auth_session` becomes a fenced insert:
  `INSERT … SELECT … WHERE NOT EXISTS (SELECT 1 FROM auth_pairing_links WHERE id = ? AND
  revoked_at IS NOT NULL)`. It returns whether a row was written. Zero rows fails the
  exchange as `invalid_grant`, before the in-memory insert (`service.rs:2778`).
- New `revoke_mcp_credential(id, now)` runs one `IMMEDIATE` transaction. It sets
  `auth_pairing_links.revoked_at = COALESCE(revoked_at, now)` where `id = ? AND subject =
  'mcp-client'`, consumed or not. It revokes `auth_sessions` row `id` if it is live, and
  bumps the authority revision if either changed. A consumed link with `revoked_at` set is
  never listed as active (`repositories.rs:2267-2272`).
- **The cache follows a publication that raced a revoke (R1.4).** Today the authority
  watcher reloads only when the durable revision changes (`service.rs:802-806`). A sweep
  can revoke a just-inserted session and be reconciled before issuance publishes it into
  the cache (`:2778-2782`). The cache then shows a revoked client until the next change.
  The watcher keeps the `authority_generation` it last reconciled at, read under the state
  lock in `reconcile_authority_snapshot` (`:2964`). It also reloads when the current
  generation differs. Issuance bumps the generation (`:2780`), so the next tick (250 ms,
  `:68`) reloads, finds the row revoked and emits the removal. Local changes are rare, so
  this costs one snapshot read per local change. It also closes the same race for every
  other revoke, not only MCP.

**Relay (`mcp/relay.rs`).**

- **Records.** A record still holds only `{pid, processStartedAt}`. There are two names:
  - `<link id>.link` while the credential is unconfirmed. The current sweep reads only
    `*.json` (`relay.rs:829-832`), so an older relay's sweep never sees this name (R1.1).
  - `<session id>.json` once the session is confirmed. That is today's name, which every
    version's sweep can revoke because the row exists by then.
- **Every record is published atomically (R1.3).** The relay writes
  `<name>.tmp-<pid>`, flushes it, then renames it to the final name. A sweep never sees a
  partial record. It ignores `*.tmp-*` files, except that it removes one older than the
  60 s link lifetime whose pid is dead. Such a file never preceded an exchange.
- **A record a sweep cannot read is skipped, not fenced (R2.1).** A record can move
  between the sweep's directory listing and its read: its owner renames `.link` to
  `.json`, or removes it. Today's sweep treats any unreadable record as an orphan
  (`relay.rs:837-847`), which would fence a live relay.
  - `NotFound`, and any other read error, skips that record for this sweep. The renamed
    `.json` is seen by the next sweep, under its live pid.
  - Only a record that was read and whose process is not alive is an orphan.
  - Atomic publication means a read record is never partial. A record that reads but does
    not parse is still treated as an orphan, as today.
- **`record_client` returns `Result` (R1.2)**, and a failure stops the sign-in.
- `mint` returns `(link_id, credential)`. The sign-in task then:
  1. publishes `<link id>.link`. If that fails, it fences the link with
     `revoke_mcp_credential(link_id)` and fails with "Could not record this MCP connection
     in `<state>/mcp-clients`: …". The credential is never sent. It then pushes `link_id`
     onto `Connection::unconfirmed`;
  2. exchanges the credential;
  3. on success, reads `sid`.
     - If `sid == link_id`, it renames `<link id>.link` to `<link id>.json`, removes the id
       from `unconfirmed`, and fills the slot. A failed rename leaves the `.link` record,
       which new sweeps handle the same way.
     - If `sid != link_id` (an older server), it first pushes `sid` onto `unconfirmed`, then
       publishes `<sid>.json`. On success it removes `sid` from `unconfirmed`, fills the
       slot, fences `link_id` and removes its `.link` record.
     - If publishing `<sid>.json` fails, it revokes `sid` at once and fails the sign-in. If
       that revoke succeeds, `sid` leaves `unconfirmed`. If it also fails, `sid` stays in
       `unconfirmed` for `revoke()` at exit (R2.2).
     - Shortcut: if the process then dies before exit, the session cannot be swept, because
       no record names `sid`. This needs an older server, plus a failed state-dir write,
       plus a failed data-root revoke, plus a crash, and the session lives to its TTL.
       Upgrading the server removes the case;
  4. on any failure after step 1 (send error, non-2xx, unreadable body, a missing or
     unreadable token), it calls `revoke_mcp_credential(link_id)`. If that succeeds, it
     removes the `.link` record and the id from `unconfirmed`. Then it returns the error.
- `revoke_sessions` and `sweep_orphans` call `revoke_mcp_credential` for each id, from
  both `.link` and `.json` records. `Connection::revoke` revokes the slot's session and
  every id left in `unconfirmed`, so a step-4 revoke that failed is retried at exit.
- A later request retries the sign-in with a new link, as today. Each attempt has its own
  link, record and id.

## Failure, restart, concurrency and security

- **Lost response.** Step 4 revokes the link and the session by the one id the relay
  already holds. If the data root is busy, the id stays in `unconfirmed` for `revoke()`,
  and the record stays for the sweep.
- **Retry.** A retry mints a new link. The lost attempt's session is already revoked (or
  queued), and its link is fenced, so no late exchange of it can succeed.
- **Crash between mint and record**, or a failed record publication. No exchange was
  sent, because the exchange waits for the record. The credential existed only in the
  process's memory, and the unconsumed link expires within 60 s (it is also fenced when
  the publication fails). Nothing to revoke.
- **Crash after record.** A dead `pid` record names the link id. The next new relay's sweep
  fences the link and revokes the session. Without a next relay the session lives up to
  30 days, the same limit a crashed relay has today (`docs/reference/mcp.md:116-120`).
- **Unwritable `mcp-clients/`.** Sign-in now fails with an actionable message rather than
  minting an untracked credential. This is a deliberate behaviour change, and the docs
  state it.
- **Revoke while the exchange is in flight.** In process, `revoke()` waits for the sign-in
  task (`relay.rs:636-638`). Across processes (a sweep racing a dead relay's request still
  on the server), SQLite serializes the three `IMMEDIATE` transactions. A fence before the
  consume makes the consume fail (`revoked_at IS NULL` in `PAIRING_RETURNING_SQL`). A
  fence between the consume and the insert makes the fenced insert write nothing. A fence
  after the insert revokes the row in the same transaction.
- **Two relays.** Each has its own link id, record and `unconfirmed` list. A sweep skips
  records whose process is alive (pid plus start time, so pid reuse is caught). Atomic
  publication means a live relay's record is never read half-written, so it is never
  fenced as an orphan. A record renamed or removed mid-sweep is skipped (R2.1). `revoke_mcp_credential` is idempotent, so two sweeps of one orphan
  are harmless.
- **Settings.** A revoke that races issuance is removed from the cached Authorized clients
  list within one watcher tick. Authentication already refused it through the durable row.
- **One session per link.** The single-use consume is unchanged, and the primary key now
  also refuses a second row with that id.
- **No token at rest.** The record still holds only `pid` and `processStartedAt`. The file
  name is the link id, never the credential. Error strings carry reqwest errors (URL and
  status, no form body) as today. New log lines name the link id only.

## Mixed versions

The relay and the server can be different builds on one data root (an older CLI next to a
newer desktop, or the reverse).

- **New relay, older server.** The server assigns a random `sid`, so step 3 records by
  `sid` and drops the link-id record: today's guarantee. The lost-response case stays
  unfixed against that server. The fence does not apply there: the old insert is not
  fenced, and the window is the gap between two adjacent commits.
- **Older relay, newer server.** The old relay reads `sid` (now the link id) and records
  it after the exchange, as today.
  - **Its sweep never sees an unconfirmed `.link` record.** Revision 0 had it revoke
    `<link id>.json` by session id. That loses a session the server inserts after that
    sweep (R1.1): `revoke_auth_session` answers `Ok(false)`, the record is deleted, and
    the late insert is unfenced.
  - It sees only `.json` records, which are written after the session row exists, so its
    plain revoke is enough.
  - Unconfirmed orphans wait for a v0.15 relay's sweep, which fences them.
- **Store.** No migration, no new column. Desktop and older servers read the same
  `auth_sessions` shape.
- **Desktop.** The watcher change (R1.4) is internal to the server and changes no event or
  contract.

## Profiler, crash and trace coverage

- **Child processes, RPC methods, binaries, shutdown, worktree removal.** None new or
  changed. `/oauth/token` is an HTTP route, not a registered RPC.
- **Logs.** A failed revoke keeps `eprintln!` on the relay's stderr (`relay.rs:707`, `:749`)
  with no token. On the server, a fenced insert that writes nothing logs
  `tracing::warn!` with the link id only. No profiler event or finding is added.

## Test plan

Fails before the change:

- `relay/tests.rs`: `a_token_response_lost_after_the_session_commit_is_revoked`. A test
  hook makes the task treat the response as unreadable after `send()` succeeded. The
  server has committed the session. Today `live_sessions == 1` after `revoke()`. After the
  change it is 0.
- `relay/tests.rs`: `a_relay_that_died_after_its_exchange_is_swept` (R1.5).
  - A test-only `die_after_send` hook ends the sign-in task right after the server
    answered. It skips steps 3 and 4 and `unconfirmed`, as a process death would. The
    test awaits the task's `JoinHandle`, so nothing keeps running.
  - It then asserts `live_sessions == 1` and that `<link id>.link` exists, and rewrites
    the record's pid to a dead one.
  - It calls `sweep_orphans(&options)` directly and asserts `live_sessions == 0` and no
    record. Today no record exists after the exchange, so the first assertion fails.
- `relay/tests.rs`: `an_unwritable_client_records_dir_sends_no_credential` (R1.2). A plain
  file named `mcp-clients` makes the directory impossible to create. Sign-in fails, there
  is no session, and the link is fenced. Today the session is created.
- `relay/tests.rs`: `a_sweep_racing_a_record_being_written_leaves_the_live_relay_signed_in`
  (R1.3). A pause hook holds publication after the temporary file is written. A second
  `Connection` sweeps, then publication resumes. The first relay signs in with no
  `invalid_grant`. Today `std::fs::write` exposes an empty `.json`.
- `relay/tests.rs`: `an_older_sweep_cannot_lose_an_unconfirmed_credential` (R1.1).
  - A dead-pid `.link` record, with the server paused after `consume_grant`.
  - The v0.14 sweep logic (`revoke_auth_session` per `*.json` stem, kept as a test helper)
    leaves the record.
  - Resume, so the insert commits. A new sweep then leaves `live_sessions == 0`.
- `relay/tests.rs`: `a_record_renamed_between_a_sweeps_listing_and_its_read_is_not_fenced`
  (R2.1). A test hook pauses the sweep after it lists the directory. The live relay
  confirms, renaming `.link` to `.json`, and the sweep resumes. The relay's next tool call
  succeeds, the session is live, and the link is not fenced. With today's read handling
  the record is fenced.
- `relay/tests.rs`: `an_older_server_session_whose_record_and_revoke_fail_is_revoked_at_exit`
  (R2.2).
  - A server double returns a token whose `sid` differs from the link id.
  - Hooks fail the `<sid>.json` publication and the immediate revoke.
  - `revoke()` at exit then leaves `live_sessions == 0`.
- `auth/service.rs`: `an_mcp_session_takes_the_id_of_its_pairing_link`.
- `auth/service.rs`: `a_revoke_between_consume_and_insert_leaves_no_session`, with a
  pause hook after `consume_grant`. The exchange fails as `invalid_grant`.
- `auth/service.rs`: `a_revoke_reconciled_before_issuance_publishes_is_removed_from_settings`
  (R1.4).
  - Pause issuance after `create_auth_session` and before the cache insert.
  - Revoke in the store, and wait for the watcher to reconcile that revision.
  - Resume, then wait one tick. `list_clients` no longer shows the session, and a
    `ClientRemoved` change was emitted. Today it stays listed.

Guards:

- `a_fenced_link_cannot_be_exchanged`.
- `a_relay_records_by_the_token_sid_when_the_server_assigns_another_id` (older server).
- `a_client_record_holds_no_credential` (reads the file and checks for neither the token
  nor the pairing credential).
- Non-MCP pairing exchanges still get random ids.
- Keep `a_sign_in_dropped_after_the_server_made_the_session_is_still_revoked`,
  `the_relay_serves_a_legacy_agent_concurrently_and_revokes_on_eof` and
  `a_revoked_relay_is_told_so_and_never_mints_again`.

Gates: `cargo test -p bibcode-server` for `mcp::relay`, `auth::` and `persistence::`,
`cargo fmt --all --check`, Clippy with `-D warnings`, `vp check`, `vp run typecheck`.

## Living docs to update

- `docs/reference/mcp.md:116-120`: a relay records each credential before it signs in,
  and a lost sign-in response is revoked too. An unwritable `<state>/mcp-clients/` fails
  sign-in. An unconfirmed orphan is cleaned up only by a v0.15 or later relay.
- `docs/architecture/overview.md` (MCP relay) or `docs/architecture/remote.md`: an
  `mcp-client` session id equals its pairing link id, and the fence rule.
- `docs/user/mcp.md` needs no change. The testing runbooks were reviewed: no command or
  procedure changes.

## Not verified

- No build or test was run (read-only task). Line references are from source reading.
- The Codex review found no code that assumes session ids and pairing ids differ (token
  parsing, auth lookups, Settings keys, audit logs). It also found no runtime pruning of
  pairing-link rows. Neither was re-checked here.
- Checked for R1.4: `reconcile_authority_snapshot` replaces the cached sessions with the
  snapshot's. For each cached session not in the snapshot, it cancels the session's live
  connections and emits `ClientRemoved` (`service.rs:3012-3044`). Not checked: whether the
  snapshot leaves revoked rows out or carries them with `revoked_at`. Either way, the
  Settings filter (`:747`) hides the session.
- Renaming over a missing target is atomic on NTFS and POSIX filesystems. Behaviour on
  network-mounted state dirs was not checked.
- The step-4 rule also revokes after a non-2xx answer, where the server may have
  committed nothing. That is harmless, but its cost under a refusal storm was not
  measured.

## Review findings and resolutions

Codex review, round 1, of revision 0. Each finding was checked against the source at
`30622da46436`. None was refuted.

| #    | Finding                                                                                                                         | Checked in source                                                                                                                                                                                                     | Resolution                                                                                                                                                                                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1.1 | P2: an older sweep revokes nothing for a record whose session is not inserted yet, deletes it, and the late insert is unfenced. | Confirmed. `revoke_auth_session` gives `Ok(false)` for a missing row (`repositories.rs:2373-2398`). The sweep deletes the record when the revoke succeeds (`relay.rs:854-857`). It reads only `*.json` (`:829-832`).  | **Fixed.** An unconfirmed record is `<link id>.link`, which no older sweep reads. It becomes `<id>.json` only once the session row exists. Mixed-versions text corrected. Test: `an_older_sweep_cannot_lose_an_unconfirmed_credential`. |
| R1.2 | P2: `record_client` swallows write errors, so an exchange can proceed with no record.                                           | Confirmed. It returns `()` and only prints (`relay.rs:733-751`).                                                                                                                                                      | **Fixed.** `record_client` returns `Result`. Sign-in fences the link and fails before the credential is sent. Test: `an_unwritable_client_records_dir_sends_no_credential`.                                                             |
| R1.3 | P2: a non-atomic write can be read as an orphan by a concurrent sweep, which fences a live relay.                               | Confirmed. `std::fs::write` to the final name (`relay.rs:739`). A malformed record reads as not alive (`:837-845`).                                                                                                   | **Fixed.** Temporary file plus rename for every record. Sweeps ignore `*.tmp-*` files and reap only stale ones with a dead pid. Test: `a_sweep_racing_a_record_being_written_leaves_the_live_relay_signed_in`.                          |
| R1.4 | P2: a revoke reconciled before issuance publishes leaves a revoked client cached in Settings.                                   | Confirmed. The watcher reloads only on a revision change (`service.rs:802-806`). Issuance publishes after the commit (`:2778-2782`). Settings reads the cache (`:744-749`). Authentication still refuses the session. | **Fixed in the shared watcher.** It also reloads when `authority_generation` moved since its last reconcile. This covers every revoke, not only MCP. Test: `a_revoke_reconciled_before_issuance_publishes_is_removed_from_settings`.    |
| R1.5 | P2: the crash test can pass through step 4's own revoke or a still-running sign-in task, without the sweep.                     | Confirmed. The sign-in runs on its own spawned task (`relay.rs:650`), and the lost-response hook would trigger step 4.                                                                                                | **Fixed.** A `die_after_send` hook ends the task before steps 3 and 4. The test awaits it, asserts one live session and a `.link` record, then calls `sweep_orphans` directly.                                                          |

Codex review, round 2, of revision 1: all five round-1 findings were accepted as resolved.
It raised two new P2 findings, both confirmed in source and neither refuted.

| #    | Finding                                                                                                                                                                    | Checked in source                                                                                      | Resolution                                                                                                                                                                                                                                                                                                                                            |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2.1 | P2: a sweep lists a `.link` record, the live relay renames it to `.json`, and the sweep's read gets `NotFound`, which today's handling treats as an orphan and fences.     | Confirmed. A failed read becomes `unwrap_or_default()`, which reads as not alive (`relay.rs:837-847`). | **Fixed.** Any read error skips the record for that sweep. Only a record that was read, with a process that is not alive, is an orphan. Test: `a_record_renamed_between_a_sweeps_listing_and_its_read_is_not_fenced`.                                                                                                                                 |
| R2.2 | P2: on an older server, if publishing `<sid>.json` and the immediate revoke both fail, only `link_id` stays tracked, so neither exit cleanup nor a sweep can revoke `sid`. | Confirmed against revision 1's step 3.                                                                 | **Fixed for exit cleanup.** `sid` is pushed onto `unconfirmed` before publication and stays there until it is recorded or revoked. A crash in that state is a documented shortcut: it needs an older server and three failures, and upgrading the server removes it. Test: `an_older_server_session_whose_record_and_revoke_fail_is_revoked_at_exit`. |
