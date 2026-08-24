# Provider error attribution — design

Date: 2026-08-18
Status: approved and implemented, except where noted under "Not implemented".
All four supported providers audited; findings below are cited to source and the
load-bearing claims independently verified.

## Problem

A failed turn presents to the user as an unattributed red banner reading
`Provider turn failed.`, with no indication of whether BiBCode or the provider
is at fault. The originating incident was an upstream Anthropic API stream drop
(`API Error: Connection lost mid-response`, `error: "server_error"`) 179 ms
after a 3 m 14 s server-side tool call, 36 m 15 s into a Claude turn. Nothing in
BiBCode contributed to the failure, yet the surface read as a BiBCode defect and
carried zero diagnostic content.

Three separate causes produced that outcome.

1. **The provider's message was discarded in projection.**
   `provider_completion_error` read `payload["error"]` / `payload["message"]`
   while the contract-canonical field is `errorMessage`
   (`packages/contracts/src/providerRuntime.ts:368`). Fixed already — see
   "Already shipped" below.
2. **Upstream error detail that providers put on the wire is never captured.**
   Claude emits `system`/`api_retry` frames carrying `error_status`, `error`,
   `attempt` and `max_retries`, and its result frame carries `terminal_reason`.
   `grep` for `api_retry`, `error_status`, `terminal_reason` across
   `apps/server/src` returns zero hits. Equivalent per-provider surfaces are
   catalogued in "Per-provider upstream signals".
3. **The UI collapses provider-origin and BiBCode-origin errors.**
   `apps/web/src/components/ChatView.tsx:1602` computes
   `threadError = localServerError ?? serverThread?.session?.lastError ?? null`.
   `localServerError` is BiBCode-origin. `session.lastError` is worse than
   provider-origin — it is _mixed_, carrying both provider failures and
   BiBCode's own restart notice (see D2). Everything renders identically, so a
   provider outage is indistinguishable from a BiBCode bug, and no field
   distinguishes them.

## Scope

Providers actually supported, by native adapter key
(`apps/server/src/production/provider_runtime.rs:4710-4719`):

| Provider   | Adapter key          | Native integration         |
| ---------- | -------------------- | -------------------------- |
| `codex`    | `codex-app-server`   | Codex App Server JSON-RPC  |
| `claude`   | `claude-stream-json` | Claude stream-JSON CLI     |
| `cursor`   | `cursor-acp`         | Agent Client Protocol      |
| `opencode` | `opencode-http`      | OpenCode server/events API |

`grok` has a runtime module but is deliberately gated off — `:3176-3180`
returns `ProviderRuntimeError::UnsupportedProvider` and `:2089` applies
`settings.enabled &= provider != "grok"`. It receives the shared plumbing for
free (single projection point) but no per-provider capture work. The provider
table in `docs/architecture/providers.md:33-38` correctly omits it.

## Already shipped (prerequisite, not the feature)

- `provider_completion_error` now reads `errorMessage` first, keeps
  `error`/`message` as fallbacks, and ignores blank strings. One shared
  projection point, so it covers every provider and both payload shapes.
- Claude's `handle_result_message` now includes the result `subtype` when the
  CLI sends no `errors`, so a detail-free failure still names its category.

This makes whatever the provider reported reach the banner. It does **not**
capture detail the provider reported elsewhere, and it does **not** attribute
origin. Those are this design.

## Constraints

- `packages/contracts` is schema-only; no runtime logic.
- Wire formats are owned by each `apps/server/src/provider/<name>/` package.
  Normalisation policy belongs at the shared projection point, not duplicated
  per provider.
- Provider wire payloads must not leak into React state
  (`docs/architecture/providers.md:40-42`).
- Attribution must be honest: BiBCode can observe _who reported_ an error, not
  _who is to blame_. A malformed BiBCode request rejected by the provider is
  provider-reported with a BiBCode root cause.

## Decisions

### D1 — Label by origin of report, not by blame

Wording is "Claude reported an error" / "BiBCode error", never "not a BiBCode
fault". Rationale: BiBCode cannot establish blame, and a confident wrong
attribution is worse than a neutral true one. Upstream-specific wording
("upstream API error") is used only when a provider signal explicitly
identifies an API-level fault (e.g. Claude's `api_retry` with an HTTP status).

### D2 — Carry origin as `RuntimeErrorClass`, reusing the existing taxonomy

**This decision was reversed during the audit.** The original position was that
origin needed no contract change, on the reasoning that
`session.lastError` is provider-origin by construction and
`localServerError` is BiBCode-origin, so the client could infer provenance from
which variable a message arrived in. That reasoning is false.

`session.lastError` is a **mixed-provenance channel**. It has exactly two
writers (every `ThreadSessionSet` dispatch and every `dispatch_session_state`
call audited):

| Writer                                                            | Text                                                                                       | True origin |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------- |
| `provider_runtime.rs:4289` → `provider_completion_error`          | the provider's message, else the literal `"Provider turn failed."`                         | provider    |
| `provider_runtime.rs:1612`, const `RESTART_ERROR` at `:1514-1515` | `"Provider session ended when BiBCode stopped. Review delivery status before continuing."` | **BiBCode** |

Verified. So a UI that labels everything in `session.lastError` as
provider-reported would mislabel BiBCode's own restart notice. The only
discriminator available today is string-matching that constant — precisely the
fragile approach `sanitizeThreadErrorMessage` already resorts to.

Origin therefore has to be carried explicitly. It should **not** be a new
`errorOrigin` field, because the contract already has the vocabulary:

```
RuntimeErrorClass = "provider_error" | "transport_error"
                  | "permission_error" | "validation_error" | "unknown"
```

`packages/contracts/src/providerRuntime.ts:95-102`, already attached as an
optional `class` on `RuntimeErrorPayload` (`:623-627`). Verified: exactly **one**
producer (`codex/runtime.rs:2302`, fatal-stderr `runtime.error`) and **zero**
consumers in `apps/web` or `packages/client-runtime`.

Decision: extend that existing taxonomy to the failure path rather than invent a
parallel one — add the class to `TurnCompletedPayload` and to the session
alongside `lastError`, and populate it from each runtime's own error
discriminant. `RESTART_ERROR` becomes `transport_error`; a provider-reported
turn failure becomes `provider_error`.

Alternatives considered:

- _A new boolean `errorOrigin: "provider" | "bibcode"`._ Rejected: duplicates
  `RuntimeErrorClass` with a coarser vocabulary, creating a second source of
  truth for the same question — the thing `AGENTS.md` explicitly forbids.
- _Keep origin implicit, string-match `RESTART_ERROR`._ Rejected: breaks the
  moment that copy is edited or localised, and it is undiscoverable.
- _Structured `errorDetail { status, code, attempts }` as well._ **Rejected**,
  not merely deferred. The class answers "whose fault", which is the question
  asked, and it has a real consumer in the banner. A structured detail object
  would have **none**: every fact it would carry already reaches the user inside
  `errorMessage` — `(HTTP 529)`, `(UsageLimitExceeded)`, `(provider: anthropic)`,
  `(the provider reported this as retryable)`, `retry 10 of 10`. Only
  machine-queryability would be added, and nothing queries it. Adding it would
  reproduce the exact defect this audit documented: this contract already carries
  `account.rate-limits.updated` with **zero producers and zero consumers**, and
  `ProviderRuntimeEventV2` as dead code. A third unused field is a cost, not an
  asset, and `AGENTS.md` forbids speculative generalization. Reopen when a
  surface needs to branch on the value rather than display it — concretely, when
  offering a retry affordance only for 429/5xx, or suppressing retry for
  `permission_error`. Add only the fields that branch, driven by the consumer.

Trade-off accepted: upstream _detail_ still travels as prose inside
`errorMessage` and is not machine-queryable; only the _class_ is structured.
That is the smallest change that makes attribution correct rather than guessed.

### D3 — Capture upstream detail in the provider package that owns the wire

Each runtime records the last upstream-error observation for the active turn,
classifies it into a `RuntimeErrorClass` (D2), and folds the human-readable part
into the `errorMessage` it already emits. Because the mechanism of loss differs
per provider (see "The unifying finding"), so does the work:

- **claude** — add an `api_retry` branch to the existing `system` subtype `match`
  at `claude/runtime.rs:1721`, which already special-cases `init` into an
  `mcp.status.updated` event. `error_status` and `error` give the class and the
  detail directly. Also read the result frame's `terminal_reason`.
- **codex, cursor** — classify from the error variant rather than its string.
  `RemoteRequest` → `provider_error`; `Closed` / `ReadFailure` / `WriteFailure` /
  `LineTooLong` / `InvalidMessage` / `UnknownResponse` → `transport_error`. The
  precedent is already in-tree: `provider_runtime.rs:5854-5863` matches
  `RemoteRequest { .. }` → `Rejected` and everything else → `Ambiguous`. Cursor's
  fix lands for grok too, since `grok/mod.rs:1` re-exports cursor's `acp`.
- **opencode** — read `error.name` and map opencode's own classification, which
  is strictly better than anything BiBCode could infer: `MessageAbortedError` →
  cancelled (not an error at all), `MessageOutputLengthError` → `max_tokens`,
  `ContentFilterError` → `refusal`, `ProviderAuthError` → `permission_error`,
  `APIError` → `provider_error` carrying `statusCode` and `isRetryable`. Also
  surface `session.status{retry}`, which already contains a written-for-humans
  explanation plus an actionable link.

Note the asymmetry this exposes: the amount of upstream truth available is
inversely proportional to how much of it BiBCode currently reads. OpenCode
offers the most and reads the least.

### D4 — Normalise the failure payload to `errorMessage`

The runtimes emit four different shapes today, and only one is declared:

| Path                                                                    | Shape emitted                                                |
| ----------------------------------------------------------------------- | ------------------------------------------------------------ |
| claude, both paths (`claude/runtime.rs:2433`, `:2185`)                  | `errorMessage`                                               |
| codex, transport dead (`codex/runtime.rs:2320-2329`)                    | `errorMessage`                                               |
| codex, normal failing turn (`codex/runtime.rs:2487-2498`)               | `error`, a verbatim copy of the provider's `turn.error` JSON |
| cursor (`cursor/runtime.rs:571`), opencode (`opencode/runtime.rs:1527`) | `error: { message }`                                         |

`TurnCompletedPayload` (`packages/contracts/src/providerRuntime.ts:363-370`)
declares only `errorMessage`, so three of the four are undeclared. Note that
codex's normal failing turn — the common case — copies the provider's wire JSON
straight into the payload, which is also the one path that would leak a provider
wire shape toward the client.

Nothing enforces that contract at runtime today: `providerRuntime.ts` is
re-exported from the contracts barrel (`packages/contracts/src/index.ts:14`) but
has no runtime consumer in `apps/web` or `packages/client-runtime` — it is the
authoritative _specification_ of the provider event shapes, not a validator on
the live path. That is how the divergence survived unnoticed, and it means
correcting it is safe: no decode behaviour changes.

Migrating cursor and opencode to `errorMessage` makes the contract truthful and
leaves one shape. The `error`/`message` fallbacks in
`provider_completion_error` stay as defence for unmapped raw payloads.

### D5 — Live visibility reuses the activity stream

An observed upstream retry emits an activity event, surfacing through the
existing activity-log machinery exactly as `mcp.status.updated` already does.
No new UI component. Rejected alternative: a bespoke live retry indicator in
the composer — more surface area for the same information.

## Per-provider upstream signals

Claude — confirmed empirically by probing the installed CLI
(`--print --output-format stream-json --verbose`):

- `{"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,`
  `"retry_delay_ms":573,"error_status":401,"error":"authentication_failed"}`
  — emitted per retry attempt on API failure. Currently dropped.
- Error result frame keys: `subtype`, `is_error`, `errors`, `stop_reason`,
  `terminal_reason`, `permission_denials`, `num_turns`, `duration_ms`,
  `duration_api_ms`, `modelUsage`, `usage`, `total_cost_usd`. Probed
  `error_max_turns` yielded `errors: ["Reached maximum number of turns (1)"]`,
  `stop_reason: "tool_use"`, `terminal_reason: "max_turns"`. BiBCode reads
  `subtype`, `is_error`, `errors`, `stop_reason`; it does not read
  `terminal_reason`.
- Frames failing `ClaudeMessage` deserialization are discarded silently at
  `apps/server/src/provider/claude/runtime.rs:1778` with no log line
  (`tracing::` count in that file: 0).

Codex — audited. Codex is not vendored under `.repos/`, so the app-server error
schema could not be read from an upstream source; findings below are from
BiBCode's own decoding and in-repo test fixtures.

- JSON-RPC error objects **are** decoded into
  `ProtocolError::RemoteRequest { code, message, data }`
  (`codex/protocol.rs:589-601`), then the detail is destroyed twice: the `Display`
  impl (`:88-95`) formats only method, code and message, and `provider_error`
  stringifies the result again (`provider_runtime.rs:9425`). Nothing anywhere
  branches on `code`. So codex's structured error detail is _captured and then
  flattened_ — the cheapest provider to improve.
- Rate limits are absent from the session path entirely. Codex exposes
  `account/rateLimits/read`, and BiBCode calls it — but from
  `provider_usage/mod.rs:875`, which spawns its own throwaway app-server for
  polling. The live session never asks. `account.rate-limits.updated` is
  declared in the contract (`providerRuntime.ts:187, 237`) with **zero producers
  and zero consumers** repo-wide (verified).
- No `api_retry` analogue exists for codex. Confirmed: `api_retry`,
  `error_status` and `max_retries` have zero non-test hits in `apps/server/src`
  for any provider.
- Auth failures, token limits and context overflow arrive only as prose in
  `turn.error.message`. `codex/activity.rs:1382-1387` reads that field as an
  object only, so a bare-string `"error": "..."` is dropped there.
- stderr is captured but codex has no `session.stderr` event type. Only lines
  matching `FATAL_STDERR_SNIPPETS` become `runtime.error`, and that list has
  exactly one entry — `"failed to connect to websocket"`
  (`codex/runtime.rs:46`, verified). Every other stderr line, including panics,
  auth errors and 429s, becomes `runtime.warning`, filed with tone `tool` and
  kind `provider.event` (`provider_runtime.rs:4632-4643`) — i.e. presented as an
  ordinary tool event.

Cursor — audited. Cursor and grok **share one protocol module**:
`grok/mod.rs:1` is `pub use crate::provider::cursor::acp;`, so every
protocol-layer fix lands for both at once. No vendored ACP spec exists under
`.repos/` (only `alchemy-effect` and `effect-smol`), so the in-repo ground truth
is the `ACP_FIXTURE` at `provider_runtime.rs:12377-12395` and the regression test
`cursor_delivery_remote_prompt_rejection_is_rejected` (`:12586-12620`).

- The full JSON-RPC error object **is** parsed and carried:
  `AcpProtocolError::RemoteRequest { method, request_id, code, message, data }`
  (`cursor/acp.rs:83-90`), built field-by-field at `:598-611`, and a test at
  `:1125-1139` asserts `data` survives. But `data` is absent from the `Display`
  format string, and the only non-test consumer destructures with `{ .. }`
  (`provider_runtime.rs:5856`). So `code` survives only as prose and `data` —
  where an agent would put `retryAfter`, a quota body, or an HTTP status — is
  captured, tested, then discarded.
- The variant discriminant is the thing that actually answers "whose fault":
  `RemoteRequest` is the provider's, while `Closed`, `LineTooLong`,
  `ReadFailure`, `WriteFailure`, `InvalidMessage`, `UnknownResponse`
  (`acp.rs:65-82`) are all BiBCode's transport. All collapse into one string at
  the `to_string()` boundary. One site already uses the discriminant correctly
  and is the pattern to generalise: `provider_runtime.rs:5854-5863` maps
  `RemoteRequest` → `Rejected` and everything else → `Ambiguous`.
- Error-carrying `session/update` variants and every non-`session/update`
  notification are dropped by catch-alls (`cursor/runtime.rs:826-828`, `:916`).
  No `api_retry` analogue exists.
- On connection close, cursor emits only `session.exited`; the active turn fails
  indirectly because `fail_connection` (`acp.rs:725-742`) resolves pending
  requests with `Closed { reason }` first. Consequence: the turn's message is the
  teardown reason, never the agent's own last words.
- stderr becomes `runtime.warning` (`cursor/runtime.rs:782-785`), which
  `event_activity_shape` does not match, so it falls to
  `_ => ("tool", "provider.event")` — provider stderr is presented as an
  ordinary **tool** activity. `session.stderr` is Claude-only
  (`provider_runtime.rs:8911`). There is no fatal-stderr classification, so an
  upstream `401`/`429`/`quota exceeded` on stderr is a plain warning.

OpenCode — audited. Driven entirely over HTTP (reqwest) plus one SSE stream,
`GET /event`, decoded to `serde_json::Value` and dispatched by string. Upstream
shapes below were extracted from the installed `opencode-ai` **1.18.18** binary;
opencode is not vendored under `.repos/`, so version drift is possible and the
supported version range is not pinned anywhere in-repo.

OpenCode has the **richest** upstream error vocabulary of any provider, and
BiBCode reads one field of it. The named error union — used for both
`session.error.properties.error` and `AssistantMessage.error`, discriminated on
`name`:

| Error `name`               | Data it carries                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------- |
| `ProviderAuthError`        | `providerID`, `message`                                                               |
| `APIError`                 | `message`, `statusCode`, `isRetryable`, `responseHeaders`, `responseBody`, `metadata` |
| `ContextOverflowError`     | `message`, `responseBody`                                                             |
| `ContentFilterError`       | `message`                                                                             |
| `MessageOutputLengthError` | _(empty)_                                                                             |
| `MessageAbortedError`      | `message`                                                                             |
| `StructuredOutputError`    | `message`, `retries`                                                                  |
| `UnknownError`             | `message`, `ref`                                                                      |

`opencode/runtime.rs:1505-1511` reads `/error/data/message`, then
`/error/message`, then `error` as a bare string, then falls back to the literal
`"OpenCode session failed."` — verified. `error.name` is never read on the root
path, so `providerID`, `statusCode`, `isRetryable`, `responseHeaders` (where
retry-after and rate-limit headers live), `responseBody`, `metadata`, `retries`
and `ref` are all dropped. Nothing fails to deserialise; the data sits in memory
unread.

Two consequences land squarely on this design's goal:

- `MessageOutputLengthError` carries **empty** data, so it falls through to the
  literal `"OpenCode session failed."` A known, benign max-output stop is
  presented exactly like an unexplained BiBCode fault — the same defect that
  opened this document, reproduced in a second provider.
- `MessageAbortedError` — the user's own interrupt — is emitted as
  `state: "failed", stopReason: "error"`, because `name` is unread and
  `stopReason` is hardcoded (`:1522-1532`, verified). opencode itself maps that
  name to `cancelled`, and `MessageOutputLengthError` → `max_tokens`,
  `ContentFilterError` → `refusal`, `ProviderAuthError` → an auth failure. **The
  classification this design needs already exists upstream and BiBCode discards
  it.**

Also dropped, and directly the signal a user needs to see that a provider is
rate-limiting rather than BiBCode failing:

- `session.status` type `"retry"`:
  `{ attempt, message, action: { reason, provider, title, message, label, link } }`
  — a human-readable backoff notice with a provider-specific hint and link.
  `opencode/runtime.rs:1481-1499` matches only `status.type == "idle"`;
  `opencode/activity.rs:621-631` maps `"retry"` to `Waiting` and discards the
  message, attempt and action. Discarded twice.
- `RetryPart` message parts (`{ attempt, error: APIError, time }`) carry the full
  `APIError` including `statusCode` and `responseHeaders`;
  `opencode/runtime.rs:1441-1447` early-returns for any part type other than
  `"text"`.
- `AssistantMessage.error` on the root session is never inspected
  (`:1413-1434` reads only `/time/completed`). The activity tracker does use it
  — but only for verified _child_ sessions, the root being excluded at
  `opencode/activity.rs:304`.

**OpenCode's stderr is not captured at all.** `spawn_child(&request, &args,
false, attribution)` at `provider_runtime.rs:6230` passes `pipe_output = false`,
which routes both stdout and stderr to `Stdio::null()` (`:5147-5151`). Verified,
and verified as unique: codex (`:5420`), cursor (`:5743`), grok (`:6002`) and
claude (`:8263`) all pass `true`. Any opencode panic, auth diagnostic or crash
message is unrecoverable, and `wait_for_endpoint` (`:9609-9639`) can therefore
only ever report `"server did not become ready within 5 seconds"`.

HTTP-level detail is discarded almost everywhere: `start()` (`:566-598`) does not
check status before `response.json()`, so a non-2xx becomes the actively
misleading `InvalidResponse("session.create missing id")`; the status-checked
paths capture the status code but never the response body; and
`interrupt_turn` (`:1004-1013`), `respond_to_user_input` (`:1015-1053`) and
`rollback_thread` (`:1064-1130`) do not check status at all, so a 4xx/5xx is
reported as success. `OpenCodeRuntimeError::Http(String)` (`:116-117`) collapses
a connection reset and an HTTP 429 into one variant separated only by prose.

## The unifying finding

Every provider already receives a rich upstream classification. None of them
surfaces it. But — and this corrects an earlier draft of this document, which
claimed a single shared `to_string()` boundary — **the mechanism differs per
provider, and each needs a different fix**:

| Provider      | Mechanism by which detail is lost                                                                                                                                                                                | Shape of the fix                                                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| codex, cursor | Parsed into a rich Rust enum (`RemoteRequest { code, message, data }`), then flattened by `Display` / `to_string()`. `data` is never in the format string; the variant discriminant dies at the string boundary. | Stop flattening — carry the discriminant. It is already parsed, and cursor even has a test proving `data` survives (`cursor/acp.rs:1125-1139`). |
| claude        | Never reaches a typed path. Closed serde enums reject the frame and it is discarded silently at `claude/runtime.rs:1778`.                                                                                        | Handle the frame — `system`/`api_retry` needs a branch in the existing subtype `match`.                                                         |
| opencode      | Nothing fails and nothing flattens: the payload is `serde_json::Value` end to end. BiBCode reads `/error/data/message` and **never reads `error.name`** (`opencode/runtime.rs:1505-1511`, verified).             | Read the fields that are already in memory.                                                                                                     |

So there is no single boundary to repair. What is common is the _outcome_: a
classification the provider already computed is thrown away and replaced with a
string.

### The consequence worth escalating

In **three of the four** supported providers, a failed turn can be reported to
the user as a **success**:

- codex — `.unwrap_or("completed")` on a missing/non-string `turn.status`
  (D-1).
- cursor — every non-`cancelled` stop reason maps to `"completed"`, so ACP
  `refusal` / `max_tokens` / `max_turn_requests` read as success (D-7).
- opencode — a dropped `session.error` leaves the turn open, and the following
  `session.status{idle}` then reports `state: "completed"` (D-13).

That is a more serious problem than the missing attribution this design was
opened for. Attribution makes a visible failure honest; these make a failure
invisible.

## Defects found during the audit

These are pre-existing bugs, not consequences of this design. Each one defeats
the goal of showing the user a truthful provider error, so they are proposed as
part of the same change. Listed worst first.

- **D-1 — a failed codex turn can be projected as success.**
  `codex/runtime.rs:2481-2486` extracts `turn.status` with
  `.unwrap_or("completed")`. A `turn/completed` frame whose `status` is missing
  or non-string yields `state: "completed"` and `session.status = "ready"` even
  when `turn.error` is populated and attached to the payload. Verified by
  reading. Silent failure: the user is told the turn succeeded.
- **D-7 — cursor presents refusals and truncation as success.**
  `cursor/runtime.rs:556` (and `grok/runtime.rs:260`) map the stop reason with
  `if stop_reason == "cancelled" { "cancelled" } else { "completed" }`, so ACP
  `refusal`, `max_tokens` and `max_turn_requests` all render as
  `state: "completed"`. Confirmed that none of those tokens appears anywhere in
  `apps/server/src`, `packages/contracts/src` or `apps/web/src`. The raw
  `stopReason` does reach the payload, so this is fixable in the mapping alone.
  Same class as D-1, different provider.
- **D-13 — an opencode upstream failure can be reported as success, and the
  trigger is upstream-controlled.** `session.error`'s `sessionID` is _optional_
  in opencode 1.18.18's schema. `payload_session_identity`
  (`opencode/runtime.rs:2798-2828`) resolves identity only from
  `properties.sessionID`, `/info/sessionID` or `/part/sessionID`; absent →
  `Missing` → routed `Foreign` (`:1313-1315`) → `return` at `:1376`. No
  `turn.completed` is emitted and the active turn is never cleared, so the
  following `session.status{idle}` (`:1481-1499`) reports
  `state: "completed", stopReason: "completed"`. Worst of the three
  success-masking defects, because whether it fires is decided by whether the
  provider populated an optional field.
- **D-14 — a user's own interrupt is reported as a provider error.**
  `opencode/runtime.rs:1522-1532` hardcodes `stopReason: "error"` and never reads
  `error.name`, so `MessageAbortedError` — an abort — is emitted as a failure.
  Verified. Directly inverts the attribution this design is meant to establish.
- **D-15 — a crashed opencode server is indistinguishable from a hung BiBCode.**
  The SSE pump ends on `Ok(None) => break` (`opencode/runtime.rs:1261`) with no
  event, no reconnect and no log, and `OpenCodeDriver`
  (`provider_runtime.rs:6170-6252`) has no child-exit watcher. `session.exited`
  is emitted only from `stop()` (`:1154-1160`). Every other provider emits
  `session.exited` with a reason from its stdio loop.
- **D-16 — an opencode auth failure presents as invalid JSON.** The `/event`
  response status is never checked (`opencode/runtime.rs:1188-1207`), so a 401
  from a wrong `OPENCODE_SERVER_PASSWORD` proceeds to parse the error body as
  SSE, yielding either silent pump death or the misleading
  `"OpenCode SSE data was invalid JSON"` (`opencode/sse.rs:126`) with the status
  code lost.
- **D-17 — opencode's stderr is discarded by the OS.**
  `provider_runtime.rs:6230` passes `pipe_output = false`, sending both streams
  to `Stdio::null()` (`:5147-5151`). Verified, and unique to opencode among all
  five drivers. There is no reader task and no `session.stderr`, so panics and
  auth diagnostics are unrecoverable.
- **D-18 — `session.error` outside a tracked turn vanishes.**
  `opencode/runtime.rs:1502-1504` returns early when there is no active turn, with
  no event and no log. Verified. Anything failing post-idle, during compaction,
  or on a background path is invisible.
- **D-2 — one stray stdout line from codex is indistinguishable from a BiBCode
  crash.** `codex/protocol.rs:507-511` propagates
  `ProtocolError::InvalidMessage` out of `read_stdout_loop` via `?`, which ends
  the loop and reaches `fail_connection` (`:704-713`), killing the session and
  surfacing as the transport-dead failure. Any non-JSON line, an unroutable
  message, a stdout line over 8 MiB (`:295-300`), or an uncorrelated response id
  (`:576-581`) all do this. Verified by reading. Directly produces the
  false-blame outcome this design exists to prevent.
- **D-8 — a malformed JSON-RPC _error object_ tears down the whole cursor
  session.** `cursor/acp.rs:598-604` deserialises the error object with
  `serde_json::from_value`; a string `code` or a missing `message` fails it into
  `InvalidMessage` → `fail_connection`. So an agent reporting a rate limit
  slightly off-spec costs the entire session instead of one turn. Same class as
  D-2, shared by grok.
- **D-9 — the shared stream-end failure discards the real reason.**
  `provider_runtime.rs:4026-4039` synthesises
  `{"state":"failed","error":{"message": STREAM_END_ERROR}}` with a hardcoded
  string when a provider event stream ends, throwing away the
  `session.exited.reason` the provider had just supplied. Verified. This is a
  third failure-payload producer, in the production layer rather than any
  provider package, and it affects every provider.
- **D-10 — an errored thread is invisible in the sidebar.** `derivePhase`
  (`apps/web/src/session-logic.ts:1364-1370`) collapses `status === "error"`
  into `"disconnected"`, so a thread whose turn failed looks identical to one
  that was simply stopped. The sidebar never reads `lastError`.
- **D-3 — failed codex child/subagent turns emit no completion at all.** Early
  returns at `codex/runtime.rs:2418-2423` fire before the method match, so no
  `turn.completed`, and nothing records the failure.
- **D-4 — a rejected `turn/start` leaves no trace.** `codex/runtime.rs:1186-1230`
  `?`-propagates into `provider_error` (`provider_runtime.rs:9420-9427`) and is
  returned as an RPC error (`:3413`). No `turn.completed`, no activity record,
  no persisted `lastError`, and the session is never marked `error`. Cursor has
  the same hole for auth failures during `start()`
  (`cursor/runtime.rs:195-256`).
- **D-11 — provider stderr is filed as a tool event.** Cursor and grok emit
  stderr as `runtime.warning`, which `event_activity_shape`
  (`provider_runtime.rs:4630-4641`) does not match, so it falls through to
  `("tool", "provider.event")`. Codex fares little better: only lines matching
  `FATAL_STDERR_SNIPPETS` — one entry, `"failed to connect to websocket"`
  (`codex/runtime.rs:46`, verified) — become errors.
- **D-5 — codex token usage is dropped wholesale on a partial frame.**
  `codex/runtime.rs:3427-3430` discards the entire
  `thread/tokenUsage/updated` notification when `last.totalTokens` is 0 or
  missing.
- **D-6 / D-12 — dropped frames are never logged.** Unknown codex notification
  methods are discarded unlogged (`codex/runtime.rs:2558`,
  `codex/activity.rs:558`), as are unknown ACP methods and `sessionUpdate`
  variants, and Claude's undeserialisable frames (`claude/runtime.rs:1778`).
  `grep -rn 'tracing::'` over `provider/cursor/`, `provider/grok/` and
  `provider/claude/runtime.rs` returns nothing. We have no field evidence of
  what is being thrown away, which is why every gap in this document had to be
  found by reading rather than from logs.

Latent, not currently reachable: grok has no `deliver` override, so it falls to
the trait default (`provider_runtime.rs:290-305`), which returns once the prompt
is _spawned_ — it would report `Accepted` for an upstream-rejected prompt. Moot
while grok is gated, but it must be fixed before it is ungated.

## Success criteria

- A failed turn's banner names the reporting provider, and where the provider
  supplied API-level detail, names the upstream fault.
- A BiBCode-origin failure is visibly distinct from a provider-origin one.
- No provider wire payload reaches React state.
- Focused tests per changed behaviour; the shared projection keeps its existing
  regression coverage.

## Documentation to update in the same change

- `docs/architecture/providers.md` — error normalisation and attribution.
- `docs/testing/` runbooks if any validation procedure changes.

## Verification

`cargo clippy -p bibcode-server --all-targets -- -D warnings` reports zero
diagnostics, and `cargo fmt --all --check`, `vp fmt --check`, `vp check`,
`vp run typecheck` and `git diff --check` are clean.

`cargo test -p bibcode-server --no-fail-fast -- --test-threads=2` runs 56 test
binaries: 2291 passed at the time of the enumeration run, with failures only in
`--lib`'s two
`git::repository::worktree_ownership_tests` cases and in
`production_worktree_catalog_rpc`. The first two pass 3/3 in isolation and touch
no file in this change; the second is red on a pristine HEAD worktree at every
concurrency, including fully serialized, and is recorded below as a pre-existing
condition rather than papered over. `cargo test -p bibcode-desktop` passes 275. Two focused tests were added after
that enumeration run — one pinning claude's `terminal_reason` decoding and one
requiring opencode's `session.exited` on stream teardown — so the current totals
are two higher; `provider_claude` (45) and `provider_opencode` (76) were re-run
green, and clippy and both formatters were re-run on the current tree.
`vp test run` passes 8144 of 8153, with the five failures confined to
`scripts/`, `oxlint-plugin-bibcode/` and `infra/` — none of them touched here,
and four of them 60s timeouts of the same host-latency kind described below.

### Run the Rust suite with `--no-fail-fast`

`cargo test` abandons every remaining test binary after the first one fails, so
a plain `cargo test -p bibcode-server` stops at the earliest red target and
reports a green-looking tail that never executed. In this change that hid four
real regressions in `provider_claude`, `provider_codex` and `provider_opencode`
behind an unrelated pre-existing failure in an alphabetically earlier binary.
Always use `--no-fail-fast` for the broad gate.

The four it hid, all found and fixed once the whole suite actually ran:

- **`errorClass` on an interrupted claude turn.** The class was attached
  whenever the payload carried an `errorMessage`, which includes a user abort,
  and the value was the meaningless `"unknown"`. An interruption is not a
  failure, so it is now left unclassified and only a genuine `failed` turn
  carries a class.
- **Two payload-shape expectations** in `provider_codex` and `provider_opencode`
  still asserted the pre-D4 `error: { message }` object. Updated to
  `errorMessage` / `errorClass`, which is the change D4 exists to make.
- **`session.exited` on SSE end-of-stream is observable.** Two opencode fixtures
  close their event stream at the end of the scenario and asserted that _no_
  event follows. The pump now reports that teardown, which is correct — the
  stream ending is how a crashed opencode server presents, and the cancellation
  path returns before emitting, so a clean stop stays silent. Both tests were
  narrowed to their actual invariants (no renderable activity for an unverified
  child frame; no second successful completion after an error) instead of
  asserting a bare event-stream silence.

Provider schemas were verified against upstream documentation rather than
inference:

- **ACP (cursor, grok)** — the five `stopReason` values `end_turn`,
  `max_tokens`, `max_turn_requests`, `refusal`, `cancelled` are the complete
  documented set, matching `acp_turn_state` exactly.
- **OpenCode** — the assistant-message error union is `ProviderAuthError`,
  `UnknownError`, `MessageOutputLengthError`, `MessageAbortedError` and
  `APIError`; the discriminant is literally `"APIError"` (all caps) even though
  the TypeScript alias is `ApiError`, and `APIError` carries `statusCode`,
  `isRetryable`, `responseHeaders` and `responseBody`.
- **Codex** — `turn.status` is `completed | interrupted | failed`, and
  `turn.error` is `{ message, codexErrorInfo, additionalDetails }` with an
  `httpStatusCode` beside the discriminator. **This corrected a regression
  introduced while fixing D-1**: the guard had preserved only `cancelled`, so an
  `interrupted` codex turn carrying an error would have been reported as
  `failed` — the user's own abort presented as a provider failure. Covered by
  `interrupted_codex_turn_carrying_an_error_stays_interrupted`.

Live end-to-end verification in the running app (Playwright/Chrome DevTools
against an isolated dev instance on randomized ports, with deliberately invalid
upstream credentials):

| Provider     | Observed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Claude**   | Banner _"Claude reported an error"_ / _"The upstream API returned an error (HTTP 401): authentication_failed; retry 10 of 10."_ Row: `('claudeAgent', 'error', <that message>, 'provider_error')`. The originating incident's failure class, now named in full.                                                                                                                                                                                                                                                         |
| **Codex**    | Banner _"Codex reported an error"_. Row: `('codex', 'error', 'Codex reported a failed turn.', 'provider_error')`. Survived a server restart, confirming the new column round-trips.                                                                                                                                                                                                                                                                                                                                     |
| **OpenCode** | Row: `('opencode', 'error', 'Provider session ended when BiBCode stopped…', 'transport_error')` — BiBCode's **own** restart notice, correctly classed as ours rather than blamed on the provider. This is the mixed-provenance case from D2 demonstrated live, and it is the reason the class had to exist. Its turn-level classifier is unit-tested; a turn-level failure could not be induced because opencode rejected the start request (HTTP 400) before a turn existed, which takes the delivery surface instead. |
| **Cursor**   | Success path verified live end to end — a real turn completed and rendered, exercising the rewritten `acp_turn_state` mapping (`end_turn` → `completed`) with no false failure. Failure classification is unit-tested across all seven `AcpProtocolError` variants; it was not forced live because the only cursor processes on the host are the user's IDE, and killing those to synthesize a transport error was not an acceptable trade.                                                                             |

Migration 44 applied cleanly to a live database; `last_error_class` is present
and populated.

### A regression the tests could not have caught: `"error": null`

Live use surfaced what neither the suite nor the earlier live verification did:
**every** successful codex turn was reported as failed, with the banner "Codex
reported an error / Codex reported a failed turn." sitting above a complete,
correct answer.

The D-1 fix read the error field as `params["turn"].get("error").cloned()`.
`Value::get` returns `Some(Null)` for a present-but-null key, and codex emits
`"error": null` on a healthy turn, so `error.is_some()` was true for every
success. The guard then overrode `status: "completed"` to `failed`, and
`classify_codex_error(Null)` fell to its default arm — which is why the message
was the generic fallback rather than anything describing a real failure.

The fix requires the error to carry content (`codex_error_is_informative`).
That is the _safer_ rule rather than a looser one: a turn codex genuinely failed
still says so in `status`, which `reported_state` honours by itself, so this
clause only ever needed to catch a missing or unrecognised status — and an empty
error carries no signal for that. Covered by
`a_successful_codex_turn_with_an_explicit_null_error_stays_completed` across
`null`, `""`, `"   "` and `{}`.

Worth recording as a testing lesson: the earlier live verification exercised
_failing_ turns for every provider, because the point was error attribution. No
one checked that a **succeeding** codex turn stayed silent, and that is exactly
where the regression lived.

### Two misattributions live use exposed

Both are the same failure this document is about — BiBCode wearing another
component's fault — reached from surfaces the audit never looked at.

- **A provider's turn-close lag read as BiBCode hanging.** The timeline showed an
  undifferentiated "Waiting for 2m 52s" with the answer already rendered. Codex
  sends `turn/completed` long after its final assistant message — measured 19.8s,
  26.1s, 41.8s and 114.9s across four turns, against 0.0s for claude and 0.3-0.5s
  for cursor, with the raw provider log confirming BiBCode projects it within
  milliseconds of arrival. The working row now distinguishes "answer delivered,
  waiting for the provider to close the turn". Note the subtlety: `answerDelivered`
  also had to join `isRowUnchanged`'s comparison for the `working` variant, or the
  new state would be computed and never rendered — covered by a test that fails
  without it.
- **"Invalid pairing token" for a token that was neither invalid nor mistyped.**
  Redemption collapses unknown, revoked, consumed, expired and proof-mismatch into
  one `None`. Two of ours had expired and one had already been consumed —
  confirmed from `auth_pairing_links.consumed_at` — and the wording sent us
  hunting for a typo each time. The precise reason is now logged server-side; the
  client message names both real causes without saying whether the credential
  existed, because confirming existence on an unauthenticated endpoint would make
  it a token-enumeration oracle. `PAIRING_TTL_MS` also moved 5m to 15m: the link
  is handed to a human who must switch windows to use it.

### Two unrelated defects the broad gate exposed

Neither belongs to provider error attribution; both are recorded because the
validation run is what surfaced them.

- **`cargo test` fail-fast hid results.** `--no-fail-fast` is now required by
  `docs/testing/cross-platform-validation.md`,
  `docs/testing/windows-desktop.md`, the execution-report template, and
  `.github/workflows/ci.yml` — CI had the same blind spot, so one red target
  suppressed every target ordered after it there too.
- **`scripts/release-smoke.test.ts` could not read a zip on Windows.** It
  resolved `tar` through `PATH`, which finds Git for Windows' GNU tar ahead of
  the bsdtar the platform actually ships. GNU tar cannot read a zip at all, and
  additionally reads a leading `X:` in an absolute path as a remote `host:path`
  ("Cannot connect to X"). It now addresses `%SystemRoot%\System32\tar.exe`
  directly, matching the existing idiom in
  `apps/desktop/e2e/support/provider-shims.test.ts`.

### Host process-creation latency, not product latency

Three pre-existing red targets, all fixed here, were separated from this change
by running them
on a freshly created, detached worktree at the same HEAD, verified clean and
verified not to contain any of this change's code:

| Target                             | Evidence                                                                   | Disposition                         |
| ---------------------------------- | -------------------------------------------------------------------------- | ----------------------------------- |
| `production_orchestration_effects` | 4/4 failures at HEAD; a real checkpoint took 7.6-11.0s against a 2s budget | Budget raised to 30s in this change |
| `process_runner::wait_for_file`    | 4s budget for a child plus a grandchild spawn                              | Budget raised to 30s in this change |
| `production_worktree_catalog_rpc`  | 18/54 failures at HEAD with `--test-threads=2`, **11/54 fully serialized** | Positive waits raised to 60s        |

`production_worktree_catalog_rpc` needed a correction to the reasoning above,
recorded because the wrong inference is an easy one to repeat. Because it failed
_serially_ on pristine HEAD, it was first judged not to be a latency problem at
all — contention was ruled out, so something structural was assumed. That does
not follow: serializing tests does not make an individual process spawn any
cheaper. Its panics were all `Elapsed`, on a 10s WebSocket response wait and on
5s waits for a removal to reach the Git boundary, and a single worktree removal
issues a handful of `git` invocations — at 3.6-4.0s each, those budgets cannot
be met on this host at any concurrency.

Raising only the waits that must _succeed_ takes the binary to 54/54. The short
`Duration::from_millis(..)` waits in the same file are deliberately untouched:
they assert that something does **not** happen, and lengthening them would
invert their meaning.

Chasing those timeouts bottomed out in the host rather than the code: on the
validating workstation a bare `cmd /c exit` measured 3.6-4.0s, `node -e 0`
3.9-4.9s and `git --version` 3.6-5.2s. Every remaining red test in this repo is
a fixed wall-clock budget over a process spawn. Two of those budgets were raised
because they failed deterministically at HEAD; the rest are recorded, not
retuned, because a budget large enough to absorb a four-second spawn stops being
a useful assertion.

## Corrections to this document's own findings

Three of the audit's reported defects did not survive verification. Recording
them so the list is not treated as outstanding work.

- **D-5 withdrawn — not a defect.** The audit reported that codex token usage is
  "dropped wholesale on a partial frame". It is deliberate: zero, missing and
  negative `last.totalTokens` are all explicitly _required_ to be ignored,
  pinned by `codex/runtime.rs` test cases named `"zero active usage"`,
  `"missing active usage"` and `"negative usage"`.
- **D-3 withdrawn — not a defect.** The audit reported that failed codex
  child/subagent turns "emit no completion, and nothing records the failure".
  The first half is true and correct; the second is false. `emit_activity` runs
  _before_ the root/child gate, and the activity tracker maps a failed child
  turn to `ActivityEntryKind::Error` / `"Turn failed"` /
  `ActivityEntryTone::Error` with detail from `turn.error.message`
  (`codex/activity.rs`). Child work is represented in the activity stream, which
  is the correct surface; projecting a child turn as a root `turn.completed`
  would corrupt the root turn's state.
- **D-4 narrowed.** A rejected turn start does leave a trace: the delivery path
  records `thread.turn-delivery-updated` with the provider and detail, and
  `TurnDeliveryNotice` renders it already naming the provider — exactly what we
  observed live for opencode's `HTTP 400`. Only visibility outside the open chat
  was missing, which the section below now closes as a derived thread-shell
  field.

## D-4 (residual): a rejected delivery is invisible outside the open chat

A definitively rejected turn start left the thread session `ready` with no
`lastError`. The failure _was_ reported in the chat by `TurnDeliveryNotice`, which
names the provider, but nothing else could see it — the sidebar's failed indicator
keys on `session.status == "error"`.

**Shipped**, on the third attempt, to the design that external review prescribed.

### History, because the first two attempts were both wrong

1. **Deferred** on the reasoning that `TurnDeliveryState::Failed` is re-listed for
   retry, so marking the session `error` could strand a stale banner.
2. **Reversed and implemented** in `deliver_claimed` — a
   `record_rejected_delivery_on_session` helper that read the session back and
   dispatched a synthetic `ThreadSessionSet` with `status: "error"`.
3. **Reverted** after external review (Codex) found that implementation unsound on
   five independent counts.
4. **Reimplemented** as a derived thread-shell field, which is what shipped.

Both original rationales were factually wrong. `Failed` rows are loaded as active
blockers but `claimable_oldest_per_thread` only claims `Pending`, so a failed row
does **not** auto-retry — the deferral reasoning was false. And the "a later turn
start clears it" reversal reasoning is not an invariant: the clearing dispatch is
best-effort and its failure is logged and discarded, and reconciliation can move
`Sending → Delivered` without ever projecting a session.

### Why attempt 2 was unsound

- **It did not fix the motivating case.** OpenCode's `prompt_async` HTTP 400
  becomes `OpenCodeRuntimeError::Http`, which `OpenCodeDriver::deliver` maps to
  `Ambiguous` → `Uncertain`. The `next_state == Failed` branch never ran.
- **Idempotency.** `delivery-rejected:{command_id}` reuses one identity per
  durable row, and manual retry resets that same row rather than creating a new
  one. The second rejection replays as a silent no-op, leaving the session
  `ready`. `attempts` cannot fix it either, since retry resets attempts to zero —
  the failure transition itself must own the occurrence identity.
- **Ownership.** Even going through `engine.dispatch`, it authored a whole
  provider-session snapshot. `docs/architecture/rpc-and-orchestration.md` assigns
  projections to `OrchestrationEngine` and provider-session lifecycle to
  `ProviderRuntimeSupervisor`; a delivery component must not read-modify-write
  that row.
- **`active_turn_id: None` can corrupt a live turn.** Delivery serialisation ends
  when the provider accepts or rejects the send, not when the turn completes, and
  the engine admits another `ThreadTurnStart` without checking session status. The
  session projector replaces the row with no CAS, and the turns projector marks
  every non-null running turn on the thread errored.
- **Non-atomic**, so a crash between the transition and the dispatch leaves the
  original gap permanently, since failed rows are not claimable. **Dismissal
  races** can resurrect an error on an already-dismissed row. And the class was
  overbroad: `Rejected` also covers local missing-row, frozen-route and
  attachment-preparation failures, all of which were labelled `provider_error`.

### What shipped instead: a derived thread-shell field

`rebuild_thread_derived_fields_tx` (`apps/server/src/orchestration/engine.rs`)
already runs inside the transaction that commits a delivery transition —
`transition_turn_delivery` calls it there. So the unresolved delivery is now
**derived** at that point rather than dispatched afterwards:

```sql
SELECT state, last_error FROM provider_turn_outbox
WHERE thread_id = ? AND state IN ('failed', 'uncertain')
ORDER BY updated_at DESC, command_id DESC LIMIT 1
```

It lands in two new nullable `projection_threads` columns
(`unresolved_delivery_state`, `unresolved_delivery_detail`, migration 045),
surfaces on the thread shell as `unresolvedDelivery: { state, detail }`, and the
sidebar renders `Delivery failed` / `Delivery uncertain` on a thread row that has
no more specific agent status.

Deriving instead of dispatching is what discharges every finding above:

| Finding                                        | Why it cannot occur                                                                                                                                 |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missed the motivating case                     | `'uncertain'` is included, so OpenCode's HTTP 400 → `Ambiguous` → `Uncertain` is covered without reclassifying anything                             |
| Reused command identity no-ops                 | There is no command and no identity — the field is a projection of current outbox state                                                             |
| Delivery service authoring a session snapshot  | `OrchestrationEngine`'s own projector owns it; `turn_delivery.rs` is untouched                                                                      |
| `active_turn_id: None` clobbering a live turn  | No session row, no turn row, and no provider identity is read or written                                                                            |
| Non-atomic; dismissal races; stale after retry | Same transaction as the committed transition, and recomputed on every subsequent one, so retry, dismissal, and success all clear it by construction |
| Overbroad error class                          | No class is asserted; the raw `last_error` detail is passed through unlabelled                                                                      |

`unresolved_delivery_is_derived_onto_the_thread_and_clears_itself`
(`engine.rs`) pins all three directions: absent while pending, present once the
row is `failed`, absent again after dismissal — and asserts explicitly that the
provider session is **not** marked errored, which is the corruption attempt 2
would have caused.

### Still outstanding: OpenCode 4xx/5xx discrimination

`OpenCodeRuntimeError::Http(String)` still discards the status code, so
`OpenCodeDriver::deliver` cannot tell a deterministic, terminal 4xx from a
retryable 5xx and reports both as `Ambiguous` → `Uncertain`. The derived field
above means the user is told either way, so this is no longer a visibility gap —
but the delivery state machine is still less precise than the protocol allows.
Closing it means threading the status through `Http` and mapping definitive
rejection statuses to `Rejected`, which changes retry behaviour and therefore
belongs with the delivery state machine's owner.

Everything else the audit raised is shipped, withdrawn as a non-defect, or closed
as a recorded decision:

- Silent drops are closed across every provider package. Claude's undecodable
  frames, codex's unknown notifications, opencode's unknown events, and both
  unhandled ACP _methods_ and unhandled `sessionUpdate` variants now log at
  `debug` — shape only, never payload, which carries conversation content.
- Structured `errorDetail` is rejected with a concrete reopen trigger, recorded
  under D2.
