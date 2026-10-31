# Webhooks reference

BiBCode sends signed HTTPS `POST` requests to endpoints a person registers, one per event:
a turn starts or ends, an approval is asked for or answered, an outside agent commits,
clones or transfers a file, or the profiler records a finding. This page is the complete
contract for a receiver and for whoever registers endpoints. The source of truth is
`apps/server/src/webhooks/` and `packages/contracts/src/webhooks.ts`; a test
(`mcp::reference_docs`) fails when an event type is missing from this page.

Related pages: [Webhooks](../user/webhooks.md) (the person's guide to the Settings tab) and
the [MCP reference](./mcp.md), whose `changes_since` and `profiler_findings` tools are how a
receiver catches up on what it missed.

A request carries ids, kinds, statuses and a cursor. It never carries a prompt, a message,
a reply, terminal output, file contents, a diff, a path, an agent's label, a token or a
secret.

## Enabling

- **Setting.** `enableWebhooks` in the environment's server settings, shown as the
  **Webhooks** switch in **Settings → Agents → Agent integrations → Webhooks**. It is off by
  default, per environment, and live: turning it off cancels every request in flight,
  abandons every queued delivery and forgets the read positions; turning it on starts from
  that moment, so nothing that happened while it was off is sent.
- **Who may manage.** Only a session with `access:read` (to list endpoints and deliveries)
  and `access:write` (to change anything, send a test or redeliver): a person's
  administrator session, such as the desktop app's own window or a browser session allowed
  to manage access. An outside agent's MCP credential never holds these scopes, so no agent
  can register, read or change webhooks, and no MCP tool exists for them.
- **MCP is not required** for webhooks, except for `profiler.finding`, which is sent only
  while the MCP server is on and its **Diagnostics** set is on (a receiver catches up on
  findings through the MCP `profiler_findings` tool).

## Registering an endpoint

In the app: **Add endpoint** in the Webhooks tab. The same operations are typed RPC methods
on the environment's WebSocket RPC (see
[RPC and orchestration](../architecture/rpc-and-orchestration.md)); every refusal is
`WebhookError` with a `reason`.

| Method                    | Scope          | Input                                                                  | Result                                 |
| ------------------------- | -------------- | ---------------------------------------------------------------------- | -------------------------------------- |
| `webhooks.list`           | `access:read`  | `{}`                                                                   | `{ enabled, endpoints, maxEndpoints }` |
| `webhooks.listDeliveries` | `access:read`  | `{ endpointId, limit? }` (50 unless set, at most 200)                  | `{ deliveries }`, newest first         |
| `webhooks.upsert`         | `access:write` | `{ id?, name, url, enabled, eventTypes, projectId?, pairedClientId? }` | `{ endpoint, secret? }`                |
| `webhooks.delete`         | `access:write` | `{ id }`                                                               | `{ deleted }`                          |
| `webhooks.rotateSecret`   | `access:write` | `{ id }`                                                               | `{ secret }`                           |
| `webhooks.sendTest`       | `access:write` | `{ id }`                                                               | `{ delivery }` after its first attempt |
| `webhooks.redeliver`      | `access:write` | `{ deliveryId }`                                                       | `{ delivery }` after its first attempt |

`webhooks.upsert` without `id` adds an endpoint; with `id` it replaces that endpoint's
editable fields. Its input rules:

- `name`: 1 to 80 characters after trimming, no control characters.
- `url`: `https://` with a host, no user name, password or fragment. Plain `http`,
  including to loopback, is never accepted. The host must resolve to public addresses only
  when a request is sent (see [Outbound rules](#outbound-rules)).
- `eventTypes`: at least one event from [Events](#events); duplicates are dropped.
  `webhook.test` is not chosen; it goes only to the endpoint it is sent to.
- `projectId`: when set, only events of that project's threads are sent. Events that name
  no project, such as `profiler.finding` and agent transfers, are then not sent to it.
- `pairedClientId`: an outside agent's `mcp-client` session that is still authorized.
  Revoking that client (or **Stop**) turns the endpoint off with `disabledReason:
  "client-revoked"`.
- `enabled`: `false` keeps the endpoint but sends nothing to it.
- At most 20 endpoints per environment (`reason: "limit"`).

**The secret** is `whsec_` followed by 64 hex characters (32 random bytes). It is returned
once, as `secret` when the endpoint is created and by `webhooks.rotateSecret`, and never
again. BiBCode keeps it in its secret store as `webhook-<endpoint id>`, readable only by the
server's user. Rotating it makes the old secret stop verifying at once.

`WebhookError.reason` values: `invalid`, `not_found`, `limit`, `webhooks_off`,
`endpoint_disabled`, `queued` (a redelivery of a delivery still queued or being sent),
`endpoint_changed` (the endpoint was edited, or turned off or on, while a test event or a
redelivery waited to be sent; nothing was sent) and `storage`.

An endpoint as `webhooks.list` returns it:

```json
{
  "id": "6f1d2c3b-7a8e-4f90-b1c2-d3e4f5a6b7c8",
  "name": "CI bridge",
  "url": "https://hooks.example.com/bibcode",
  "enabled": true,
  "eventTypes": ["thread.status_changed", "approval.requested"],
  "projectId": null,
  "pairedClientId": null,
  "consecutiveFailures": 0,
  "disabledReason": null,
  "pendingDeliveries": 0,
  "lastDeliveryState": "delivered",
  "droppedDeliveries": 0,
  "createdAt": "2026-10-31T09:00:00.000Z",
  "updatedAt": "2026-10-31T09:00:00.000Z"
}
```

`disabledReason` is `failures` (ten failed deliveries in a row) or `client-revoked`, else
null. A person's **Re-enable** is an upsert with `enabled: true`, which clears the failure
count.

## Events

| Event type                | Category      | Source                                                                                                      | Extra fields                       |
| ------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `thread.status_changed`   | `threads`     | A change-feed entry `turn.started`, `turn.completed`, `turn.interrupted`, `turn.failed` or `session.status` | `kind`, `status`                   |
| `worktree.created`        | `threads`     | A `thread.created` entry whose thread has a worktree                                                        | `kind`                             |
| `panel.created`           | `threads`     | A `panel.created` entry (a chat panel was opened)                                                           | `kind`                             |
| `approval.requested`      | `approvals`   | An `approval.requested` entry                                                                               | `kind`, `requestId`                |
| `approval.resolved`       | `approvals`   | An `approval.resolved` entry; `status` is `resolved` or `expired`                                           | `kind`, `status`, `requestId`      |
| `clone.completed`         | `operations`  | An `agent.call` entry of `clone_repository`                                                                 | `kind`, `status`, `tool`, `target` |
| `scm.operation_completed` | `operations`  | An `agent.call` entry of any tool in the Source control set (Git and pull request tools)                    | `kind`, `status`, `tool`, `target` |
| `transfer.completed`      | `operations`  | An `agent.call` entry of a transfer the `files_download` or `files_upload` URL served, `status: success`    | `kind`, `status`, `tool`, `target` |
| `transfer.failed`         | `operations`  | The same, with any other `status` (the failure's tag)                                                       | `kind`, `status`, `tool`, `target` |
| `profiler.finding`        | `diagnostics` | A profiler finding that appeared, or recurred with a higher count                                           | `finding`                          |
| `webhook.test`            | —             | **Send test event** (`webhooks.sendTest`); only to that endpoint, never chosen                              | none                               |

Notes on the sources:

- Every event but `profiler.finding` and `webhook.test` is made from one entry of the MCP
  change feed, the same entries `changes_since` returns (see the
  [MCP reference](./mcp.md#change-feed-and-capabilities)). The feed's other entries
  (`thread.created` without a worktree, `thread.archived`, `turn.requested`,
  `input.requested`, `input.resolved`) have no event.
- `worktree.created` is sent for any thread created with a worktree, by a person or an
  agent.
- `clone.completed` follows the `clone_repository` call, not the clone: a clone still
  running when the call answered is reported with `status: "success"` and its
  `target.cloneId`; the MCP tool `clone_status` says how it ended.
- `scm.operation_completed` covers only changes an outside agent made through MCP. Git
  operations a person runs in the app, and file changes, are not sent: BiBCode keeps no
  durable record of them.
- A `files_upload` call that mints a URL is not an event; the transfer the URL later serves
  is.

## Payload

The body is one JSON object, `Content-Type: application/json`:

| Field           | Type   | Present                                    | Meaning                                                                                                                   |
| --------------- | ------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `id`            | string | always                                     | The event's id: `ev_` and 24 hex characters, the same on every delivery and redelivery of this event. Drop repeats by it. |
| `type`          | string | always                                     | The event type.                                                                                                           |
| `occurredAt`    | string | always                                     | ISO 8601 time of the change (for a finding, its `lastSeen`).                                                              |
| `environmentId` | string | always                                     | The environment that sent it.                                                                                             |
| `threadId`      | string | when the entry names a thread              | The thread.                                                                                                               |
| `cursor`        | string | every feed event                           | The `changes_since` cursor just after this event (`v1.<sequence>.<activityId>`; treat it as opaque).                      |
| `kind`          | string | every feed event                           | The change-feed entry kind (`turn.completed`, `approval.requested`, `agent.call`, ...).                                   |
| `status`        | string | when the entry has one                     | The session status, approval status (`resolved`, `expired`), or an agent call's outcome (`success` or its error tag).     |
| `requestId`     | string | approvals, when the provider's id is plain | The approval's id (letters, digits, `_`, `.`, `:`, `-`, at most 128); else left out.                                      |
| `tool`          | string | operation events                           | The MCP tool that ran.                                                                                                    |
| `target`        | object | operation events, when known               | Ids and counts only: `sha`, `revertedSha`, `pullRequest`, `worktreeKey`, `fileCount`, `cloneId`, `transferId`.            |
| `actor`         | object | when an outside agent caused the change    | `{ kind: "mcp-client", clientId }`; never the agent's label. Left out when either value is not an id.                     |
| `finding`       | object | `profiler.finding`                         | `{ id, count, lastSeen }`.                                                                                                |
| `dropped`       | object | after deliveries were dropped              | `{ count, fromCursor?, toCursor?, sinceLastSeen? }`; see [Dropped deliveries](#dropped-deliveries).                       |

Examples:

```json
{
  "id": "ev_4f1c9e0a7b2d3c5e6f708192",
  "type": "thread.status_changed",
  "occurredAt": "2026-10-31T10:00:00.123Z",
  "environmentId": "env_8c2f",
  "threadId": "b2f7a3c4-91de-4f1b-8a55-2c0d6e1f9a30",
  "cursor": "v1.4821.37",
  "kind": "turn.completed",
  "status": "ready",
  "actor": { "kind": "mcp-client", "clientId": "9d1e5b2a-0c3f-4e7a-8b6d-1f2e3a4b5c6d" }
}
```

```json
{
  "id": "ev_0a9b8c7d6e5f4a3b2c1d0e9f",
  "type": "scm.operation_completed",
  "occurredAt": "2026-10-31T10:05:12.004Z",
  "environmentId": "env_8c2f",
  "threadId": "b2f7a3c4-91de-4f1b-8a55-2c0d6e1f9a30",
  "cursor": "v1.4830.41",
  "kind": "agent.call",
  "status": "success",
  "tool": "git_commit",
  "target": { "sha": "3f9a1c0e7d2b4a6c8e0f1a2b3c4d5e6f7a8b9c0d" },
  "actor": { "kind": "mcp-client", "clientId": "9d1e5b2a-0c3f-4e7a-8b6d-1f2e3a4b5c6d" }
}
```

```json
{
  "id": "ev_5e6f7a8b9c0d1e2f3a4b5c6d",
  "type": "profiler.finding",
  "occurredAt": "2026-10-31T10:07:00Z",
  "environmentId": "env_8c2f",
  "finding": { "id": "rpc.slow-3fa2c1d0b9e8", "count": 4, "lastSeen": "2026-10-31T10:07:00Z" }
}
```

A `webhook.test` body has only `id` (`ev_` and 32 hex characters, new each time), `type`,
`occurredAt` and `environmentId`, plus [`dropped`](#dropped-deliveries) when the endpoint has
drop batches it was not told about: a test event is sent the same way as any other, and a
`2xx` to it acknowledges those batches.

## Headers and signature

| Header                | Value                                                               |
| --------------------- | ------------------------------------------------------------------- |
| `Content-Type`        | `application/json`                                                  |
| `User-Agent`          | `BiBCode-Webhooks/<server version>`                                 |
| `X-BibCode-Event`     | The event type                                                      |
| `X-BibCode-Delivery`  | This delivery's id; a redelivery of the same event has a new one    |
| `X-BibCode-Timestamp` | Unix seconds when this attempt was signed                           |
| `X-BibCode-Signature` | `v1=` and the lowercase hex HMAC-SHA256 of `timestamp + "." + body` |

The HMAC key is the secret exactly as shown, `whsec_` prefix included, as UTF-8 bytes. The
message is the decimal timestamp header, a `.`, then the raw body bytes. Each attempt,
retries included, is signed again with a fresh timestamp. To verify:

1. Read the raw body bytes before parsing them.
2. Compute `"v1=" + hex(HMAC-SHA256(secret, timestamp + "." + body))` and compare it with
   `X-BibCode-Signature` in constant time.
3. Refuse a timestamp more than 5 minutes (300 seconds) from your clock, so a captured
   request cannot be replayed later.
4. Drop an event whose `id` you already processed.

**Worked example.** Secret `whsec_test`, timestamp `1700000000`, body `{}`. The signed
message is `1700000000.{}`, and the header is:

```text
X-BibCode-Signature: v1=35495024f4ef3f94e5a93e22221544c4b75e9a42300cd965ab81cb85cd994e91
```

Python:

```python
import hashlib, hmac, time

def verify(secret: str, headers, body: bytes) -> bool:
    timestamp = headers["X-BibCode-Timestamp"]
    if abs(time.time() - int(timestamp)) > 300:
        return False
    expected = "v1=" + hmac.new(
        secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, headers["X-BibCode-Signature"])
```

Node.js:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

export function verify(secret, headers, body /* Buffer */) {
  const timestamp = headers["x-bibcode-timestamp"];
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = Buffer.from(
    "v1=" + createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex"),
  );
  const given = Buffer.from(headers["x-bibcode-signature"] ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

## Outbound rules

- **HTTPS only**, with no user name or password in the URL.
- **Public addresses only.** For each attempt the host is resolved once (10 s limit), and
  every address it resolves to must be globally reachable: loopback, private, link-local,
  carrier-grade NAT, documentation and other special-use ranges are refused
  (`address_refused`). The request then connects to exactly those addresses, so a DNS change
  between the check and the connection cannot redirect it.
- **No redirects, no proxy.** A `3xx` is a failure (`redirect`), never followed; system and
  environment proxy settings are ignored.
- **Bounded.** 5 seconds to connect and 10 seconds in all. Only the status code is read;
  the response body is ignored.

## Responses, retries and ordering

- Any `2xx` is a success.
- A timeout, a connection or TLS error, a host that did not resolve, a `5xx` or a `429` is
  retried after 30 seconds, then 2, 5, 10 and 15 minutes: the first attempt and five
  retries over about 32 minutes. Then the delivery fails.
- Any other answer fails at once: another `4xx`, a redirect, a refused address or URL, or a
  missing secret (nothing is ever sent unsigned).
- **Order.** One request at a time goes to each endpoint, always its oldest pending
  delivery, so a retrying delivery holds back that endpoint's later ones (order over
  throughput). At most eight endpoints have a request in flight at once. A test event or a
  redelivery waits for the endpoint's request in flight.
- **Redeliver** sends a finished delivery's event again as a new delivery (same `id`, new
  `X-BibCode-Delivery`), retried and counted like any other. A delivery still `pending` or
  `sending` cannot be redelivered (`queued`).
- **Test events** are never retried and never count toward the endpoint's health. A test
  may go to a disabled endpoint, never while webhooks are off.

Each delivery in `webhooks.listDeliveries` has `state` (`pending`, `sending`, `delivered`,
`failed`, `abandoned`), `attempts`, `lastStatus`, `latencyMs`, `nextAttemptAt` and
`lastError`, one of `status` (see `lastStatus`), `timeout`, `connect`, `unresolved`,
`address_refused`, `url_refused`, `secret_missing`, `redirect`, `cancelled`, `queue_full`,
`endpoint_changed` or `interrupted` (a `sending` row a stop cut off, failed at the next start
and never resent). Finished deliveries are kept 7 days, at most 1,000 per endpoint.

## Auto-disable

- **Failures.** Ten failed deliveries in a row turn the endpoint off with
  `disabledReason: "failures"`; a success resets the count. A person re-enables it.
- **Paired client revoked.** When the paired MCP client is revoked or stopped, the endpoint
  turns off with `disabledReason: "client-revoked"`.
- Turning an endpoint off, by hand or automatically, cancels its request in flight and
  abandons what was queued for it.

## Edits and revisions

Each endpoint has a revision that moves when its URL, project or event list changes, and
when it is turned off or on. In the same transaction BiBCode abandons every delivery queued
for it (`lastError: "endpoint_changed"`, shown as "Not sent: the endpoint's URL or events
changed"), and a request in flight is cancelled. A delivery is stamped with the revision it
was chosen under and is never sent under another one, so nothing queued for an old
destination or filter reaches the new one, even across an edit and its undo. A test event or
redelivery built before an edit is refused (`endpoint_changed`). Renaming keeps the queue.

## Dropped deliveries

Deliveries wait in BiBCode's database, so a restart resumes them. At most 10,000 pending
deliveries wait in the environment, across all endpoints; past that the oldest are abandoned (`queue_full`), counted on the endpoint
as `droppedDeliveries`, and recorded as numbered drop batches. The endpoint's next request
then carries:

```json
"dropped": {
  "count": 412,
  "fromCursor": "v1.5100.60",
  "toCursor": "v1.5511.72",
  "sinceLastSeen": "2026-10-31T09:58:00Z"
}
```

- `count` is the total over the batches not yet acknowledged; `fromCursor` and `toCursor`
  span the dropped feed events, and `sinceLastSeen` is the earliest dropped finding's
  `lastSeen`. Each range field is present only when a dropped event had one.
  `fromCursor` is the position just before the first dropped event, so
  `changes_since { cursor: fromCursor }` returns that event first (it can also return one
  entry you already processed just before it; drop repeats by the event `id`). `toCursor` is
  the last dropped event's own `cursor`.
- A `2xx` to that request acknowledges exactly the batches it named. A drop recorded
  meanwhile is named on a later request, never repeated in it.
- Catch up from `fromCursor` with `changes_since` and from `sinceLastSeen` with
  `profiler_findings`, as below. Resuming from the `cursor` of the last event you processed
  works too, and needs no `dropped` field.

## Catching up

A receiver that was down, or saw a `dropped` field, recovers through an MCP connection to
the same environment ([MCP reference](./mcp.md)):

- **Thread, approval and agent events.** Call `changes_since { cursor }` with the `cursor`
  of the last event you processed (or `dropped.fromCursor`, which lies just before the first
  dropped event), then again with each result's
  `cursor` while `more` is true. It returns every feed entry after that point, the ones whose
  webhook you missed included; map entries to events as in [Events](#events). Pass the same
  `threadId` filter each time if you use one.
- **Profiler findings.** Call `profiler_findings { since }` with the `lastSeen` of the last
  finding you processed (or `dropped.sinceLastSeen`). `since` is inclusive, so a finding
  recorded in the same second is not missed; results come oldest first, at most 100 a page,
  and you follow `nextCursor` until it is null. Drop repeats by `id` and `count`; a finding
  that recurs comes again with its new `count` and `lastSeen`.

Limits of catch-up:

- Thread and approval events come from BiBCode's event log, which is never pruned.
- Agent operations (clones, Git and pull request changes, transfers) come from the agent
  activity log, kept 7 days and at most 5,000 rows. A cursor older than that returns
  `activityDropped: true`, and those operations cannot be recovered.
- The findings book keeps at most 1,000 findings.

Catch up soon after a gap, especially after `dropped`, which means the gap was large.

## Privacy and logs

- The secret is a file in the secret store, never in settings, app state or logs.
- A failed delivery is logged with the endpoint's id and the failure tag, never its URL,
  which may carry a token.
- Payloads hold ids, kinds, statuses, cursors and counts only (see [Payload](#payload)).
