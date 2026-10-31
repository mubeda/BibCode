# Webhooks

BiBCode can tell another service when something happens in an environment: a thread's
turn starts or ends, an approval is asked for or answered, an outside agent commits or
clones, or the profiler records a finding. It sends a signed HTTPS `POST` to each endpoint
you register. A request carries ids, kinds, statuses and a cursor, never a prompt, a
message, a reply, terminal output, file contents, a diff or a token.

The [webhooks reference](../reference/webhooks.md) is the complete contract for a
receiver: every event's payload, signature verification, retries and catch-up.

## Set it up

1. Open **Settings → Agents → Agent integrations**, choose the environment if you have more
   than one, and open the **Webhooks** tab.
2. Turn on **Webhooks**. It is off until you turn it on, for each environment.
3. Click **Add endpoint**, give it a name and an `https://` URL, and choose the events to
   send. You can limit it to one project, and pair it with an MCP client so that revoking
   that client turns the endpoint off.
4. Copy the **signing secret** shown once. BiBCode keeps it in its secret store and never
   shows it again; **Rotate secret** makes a new one, and the old one stops working at once.
5. Click **Send test event** to check that your receiver answers.

The section header sums up the environment: whether MCP is on, how many agents are
connected, and how many endpoints are active and failing. Each endpoint lists its recent
deliveries (time, event, status, attempts, latency) with **Redeliver**.

Managing webhooks needs an administrator session on that environment (`access:read` to see
them, `access:write` to change them). An outside agent's MCP credential never holds these,
so agents cannot add, read or change webhooks.

An environment has at most 20 endpoints. **Delete** asks first, because the endpoint's
delivery log and secret go with it.

## What BiBCode sends to

- **HTTPS only**, with no user name or password in the URL. Plain `http`, including to this
  computer, is not offered.
- **Public addresses only.** For each attempt the host is resolved once, and every address
  it resolves to must be public: loopback, private, link-local, carrier-grade NAT and other
  special-use addresses are refused. The request then connects to exactly those addresses,
  so a DNS change between the check and the connection cannot redirect it.
- **No redirects, no proxy.** A `3xx` answer is a failure, never followed, and system or
  environment proxy settings are ignored.
- **Bounded.** 5 seconds to connect and 10 seconds in all. Only the status code is read;
  the response body is ignored.

## Events

| Event                     | When                                                                                                  | Category         |
| ------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------- |
| `thread.status_changed`   | A turn starts, completes, is interrupted or fails, or the session's status changes (`kind`, `status`) | Threads          |
| `worktree.created`        | A thread that has a worktree is created (a new worktree, by a person or an agent)                     | Threads          |
| `panel.created`           | A chat panel is created                                                                               | Threads          |
| `approval.requested`      | A thread asks for an approval (`requestId` when the provider's id is a plain id)                      | Approvals        |
| `approval.resolved`       | An approval is answered (`status: resolved`) or expires (`status: expired`)                           | Approvals        |
| `clone.completed`         | An outside agent's `clone_repository` call answered (`status` is its outcome; see below)              | Agent operations |
| `scm.operation_completed` | An outside agent's Git or pull request tool changed something (`tool`, `status`, `target`)            | Agent operations |
| `transfer.completed`      | An outside agent's file download or upload finished                                                   | Agent operations |
| `transfer.failed`         | An outside agent's file download or upload failed (`status` names why)                                | Agent operations |
| `profiler.finding`        | The profiler records a new finding, or one recurs (`finding`)                                         | Diagnostics      |
| `webhook.test`            | You clicked **Send test event**; sent only to that endpoint                                           | —                |

`profiler.finding` is sent only while MCP is on and **What agents can use → Diagnostics** is
on, because a receiver catches up on findings through the MCP `profiler_findings` tool.

`clone.completed` follows the call, not the clone: a clone still running when the call
returned is reported with `status: success` and its `target.cloneId`; `clone_status` says
how it ended.

Git operations a person runs in the app, and file changes, are not sent: BiBCode keeps no
durable record of them to send from.

## Payload

```json
{
  "id": "ev_4f1c9e0a7b2d3c5e6f708192",
  "type": "thread.status_changed",
  "occurredAt": "2026-10-31T10:00:00.123Z",
  "environmentId": "env_…",
  "threadId": "thread_…",
  "cursor": "v1.4821.37",
  "kind": "turn.completed",
  "status": "ready",
  "actor": { "kind": "mcp-client", "clientId": "…" }
}
```

- `id` is the event's: every delivery and redelivery of one event carries the same `id`, so
  drop repeats by it.
- `cursor` is on every event except `profiler.finding` and `webhook.test`. It is the
  `changes_since` cursor just after this event.
- `kind`, `status`, `requestId`, `tool`, `target` and `actor` are those of the
  `changes_since` entry. `actor` is present when an outside agent caused the change: its
  kind and an opaque `clientId`, never the agent's name, which is text the client chose.
- `profiler.finding` carries `finding: { "id", "count", "lastSeen" }` instead of `cursor`.
- `dropped` appears on the first delivery after BiBCode had to drop deliveries for this
  endpoint because its queue was full: `{ "count", "fromCursor", "toCursor",
  "sinceLastSeen" }` (each range field only when a dropped event had one). Catch up from
  `fromCursor` with `changes_since`, and from `sinceLastSeen` with `profiler_findings`. A
  `2xx` to that delivery acknowledges what it named; a drop that happens meanwhile is named
  on a later delivery, never repeated in it.

## Headers and signature

| Header                | Value                                                     |
| --------------------- | --------------------------------------------------------- |
| `X-BibCode-Event`     | The event type                                            |
| `X-BibCode-Delivery`  | This delivery's id (a redelivery has a new one)           |
| `X-BibCode-Timestamp` | Unix seconds when this attempt was signed                 |
| `X-BibCode-Signature` | `v1=` and the hex HMAC-SHA256 of `timestamp + "." + body` |

The HMAC key is the secret exactly as shown (`whsec_…`, as UTF-8). To verify a request:

1. Read the raw body bytes before parsing them.
2. Compute `HMAC-SHA256(secret, timestamp + "." + body)` and compare its hex, prefixed with
   `v1=`, to `X-BibCode-Signature` in constant time.
3. Refuse a timestamp more than 5 minutes from your clock, so a captured request cannot be
   replayed later. Each retry is signed again with a fresh timestamp.

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

For example, with the secret `whsec_test`, the timestamp `1700000000` and the body `{}`, the
signature is `v1=35495024f4ef3f94e5a93e22221544c4b75e9a42300cd965ab81cb85cd994e91`.

## Retries and failures

- Any `2xx` is a success.
- A timeout, a connection error, a host that did not resolve, a `5xx` or a `429` is tried
  again after 30 seconds, 2, 5, 10 and 15 minutes: the first attempt and five retries over
  about 32 minutes. Any other answer (a `4xx`, a redirect, a refused address) fails at once.
- One request at a time goes to each endpoint, oldest first, so events arrive in order. A
  test event or a redelivery waits for the endpoint's request in flight. **Redeliver** works
  on a finished delivery only, never one still queued or being sent.
- Changing an endpoint's URL, project or events drops what was waiting for it (the log shows
  "Not sent: the endpoint's URL or events changed"): nothing queued for the old destination
  or filters goes to the new one. Renaming it keeps the queue. A test event or redelivery
  waiting to be sent when the endpoint is edited, or turned off or on, is not sent: it says
  the endpoint changed, and you can send it again.
- Ten failed deliveries in a row turn the endpoint off, with a warning and **Re-enable**.
- Turning **Webhooks** off, or an endpoint, stops its request in flight and drops what was
  waiting for it. Turning webhooks on again starts from that moment; what happened while
  they were off is not sent.
- Deliveries wait in BiBCode's database, so a restart resumes them. At most 10,000 wait; past
  that the oldest are dropped, each shown in the log as "Not sent: the queue was full", the
  endpoint's status counts them, and its next delivery carries `dropped` (see Payload).
  Finished deliveries are kept for 7 days, at most 1,000 per endpoint.

## Catching up after missed deliveries

A receiver that was down, or missed requests, recovers the events it missed, within the
limits below:

- **Thread, approval and agent events:** call the MCP tool `changes_since` with the `cursor`
  of the last event you processed, and again with each result's `cursor` while `more` is
  true. It returns every change after that point, including the ones whose webhook you
  missed.
- **Profiler findings:** call `profiler_findings` with `since` set to the `lastSeen` of the
  last finding you processed. `since` includes that second, so a finding recorded in the same
  second is not missed; drop repeats by `id` and `count`, and follow `nextCursor` while it is
  set.

Both tools need an MCP connection to the environment ([Outside agents over MCP](./mcp.md)).

**Limits.** Thread and approval events come from BiBCode's event log, which is never pruned.
Agent operations (clones, Git and pull request changes, transfers) come from the agent
activity log, which keeps 7 days and at most 5,000 rows: a cursor older than that returns
`activityDropped: true`, and those operations cannot be recovered. The findings book keeps
at most 1,000 findings. Catch up soon after a gap, and especially after `dropped`, which
means the gap was large.

## Where secrets live

An endpoint's secret is a file in BiBCode's secret store (`webhook-<id>`), readable only by
your user, as the host identity secret is. It is never in settings, the app's state or the
logs. A failed delivery is logged with the endpoint's id and status, never its URL, which may
carry a token.
