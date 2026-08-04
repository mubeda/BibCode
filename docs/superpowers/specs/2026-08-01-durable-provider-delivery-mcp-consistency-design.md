# Durable Provider Delivery and MCP Consistency Design

**Status:** Approved design; implementation not started  
**Date:** 2026-08-01  
**Scope:** Complete the compact chat composer toolbar backend work for Codex, Claude, OpenCode, and Cursor

## Context

The compact composer toolbar is implemented and verified, but its attachment/provider-delivery and MCP-status changes exposed two classes of correctness gaps:

1. A user turn can become durable in SQLite without a restart-safe handoff to the selected provider. Command replays, process aborts, RPC cancellation, and bootstrap cancellation can therefore leave orphan files, untracked provider sends, or accepted turns that are never delivered.
2. MCP discovery and lifecycle notifications currently mutate shared state from multiple async paths. Refresh overlap, reconnect root changes, and event publication can therefore expose partial or regressing snapshots.

The repository is early-stage, but these are data-integrity boundaries. The design deliberately broadens the backend change instead of accepting local patches around each race.

## Goals

- Make local command acceptance exactly-once for a validated `commandId` and canonical payload digest.
- Atomically persist a user turn, attachment ownership, and provider-delivery intent.
- Recover accepted turns after cancellation, panic-abort, process termination, or restart.
- Preserve turn order within a thread while allowing bounded delivery concurrency across threads.
- Reconcile ambiguous sends automatically when the provider exposes a stable client-selected message identifier.
- Show a durable, user-visible `Delivery uncertain` state when safe automatic reconciliation is impossible.
- Ensure every emitted MCP status event is a complete, ordered snapshot for the active provider root.
- Preserve the existing one-server-process-per-state-root operating model and add no dependency.

## Non-goals

- Claim global exactly-once delivery for providers that do not expose suitable idempotency or readback APIs.
- Store attachment bytes in SQLite.
- Add multi-process outbox leases. BiBCode supports one server process per state root.
- Backfill and resend historical accepted turns.
- Build a generic workflow/saga framework.
- Change agent selection or add provider selection to the compact composer toolbar.

## Guarantees

### Local acceptance

For newly accepted commands, `(command_id, payload_digest)` identifies one immutable request:

- Same ID and same digest returns the original receipt.
- Same ID and a different digest returns a conflict.
- A replay never commits new attachments or creates provider work.
- SQLite acceptance includes the user-turn event, attachment references, and provider outbox row in one transaction.

### Provider delivery

The guarantee depends on provider capability:

| Provider | Stable client identity | Ambiguous-send recovery | Automatic behavior |
| --- | --- | --- | --- |
| Codex | `clientUserMessageId` | Read the thread and match the echoed client ID | Reconcile; resend only when authoritatively absent |
| OpenCode | `messageID` | Fetch the exact message ID | Reconcile; resend only when authoritatively absent |
| Claude | No documented client-selected message ID for stream-json input | Input replay acknowledges observed messages but does not provide durable exact lookup | Persist `uncertain`; never resend automatically |
| Cursor | ACP v1 message IDs are agent-generated | No client-selected prompt/message ID suitable for exact lookup | Persist `uncertain`; never resend automatically |

BiBCode therefore provides automatic effectively-once recovery for Codex and OpenCode, and conservative at-most-once automatic behavior after ambiguity for Claude and Cursor. A manual retry for an uncertain turn may duplicate a provider turn; the UI says so before the user chooses it.

## Chosen Architecture

Use a SQLite transactional outbox while retaining attachment bytes on the filesystem:

```text
RPC validation + attachment staging
                 |
                 v
Existing orchestration engine worker
  one SQLite transaction:
  - command receipt + payload digest
  - thread/bootstrap and user-turn events
  - attachment references
  - provider outbox row
                 |
                 v
Outbox dispatcher
  - oldest eligible turn per thread
  - bounded concurrency across threads
  - provider-specific reconciliation
                 |
                 v
Durable delivery outcome + conversation event
```

The provider call never occurs before the SQLite transaction commits. The RPC response does not own accepted work after the engine has admitted the complete envelope.

## Alternatives Considered

### Store attachment bytes in SQLite

This gives one storage transaction but increases database size, write amplification, backup cost, and memory pressure for files up to the existing attachment limit. It conflicts with the repository's performance priority and is unnecessary because database references plus startup garbage collection provide the required process-crash behavior.

### Custom filesystem intent journal

A separate append-only file journal could coordinate attachment publication and provider dispatch, but it would recreate transaction, compaction, ordering, and recovery machinery that SQLite already provides.

### Retry every ambiguous send

This would be simple but can duplicate turns for Claude and Cursor. The design exposes uncertainty instead.

## Command Admission

### Canonical payload digest

The RPC boundary decodes the typed orchestration command, recursively sorts JSON object keys, serializes the canonical value, and hashes it with the SHA-256 implementation already present in the server dependency graph. The digest covers the original validated request, including attachment metadata and `dataUrl` content.

The raw digest is computed before attachment publication, allowing an existing receipt to short-circuit safely:

1. Existing receipt with the same digest: return the stored result; do not prepare attachments.
2. Existing receipt with a different digest: return a command conflict.
3. Legacy receipt with no digest: return the stored result inertly; do not prepare attachments or route provider work.
4. No receipt: prepare attachments and send one owned admission envelope to the engine worker.

Concurrent submissions can both pass the preflight read. The command receipt primary key is still authoritative inside the engine transaction. The loser receives replay/conflict semantics and its uncommitted attachment batch is released.

### One owned engine envelope

Bootstrap currently performs multiple operations before the final turn is admitted. Replace that sequence with one internal engine envelope that owns:

- the prepared attachment batch;
- optional thread creation and project-setup intent;
- the user turn;
- the canonical digest;
- the frozen provider route and payload.

The engine worker either commits the complete envelope or rolls it back. Its work continues even if the RPC response receiver is dropped.

Cancellation semantics are therefore explicit:

- Before enqueue: the prepared batch drops; no database rows or setup work exist.
- During admission: the engine worker commits all durable intent or none of it.
- After commit: setup and provider delivery continue from durable state, independent of the RPC future.

## Persistence Model

### Command receipts

Add a nullable column to the existing table:

```sql
ALTER TABLE orchestration_command_receipts
ADD COLUMN payload_digest TEXT;
```

Application code requires a digest for every new receipt. The column remains nullable only for migrated rows.

### Provider turn outbox

```sql
CREATE TABLE provider_turn_outbox (
  command_id TEXT PRIMARY KEY
    REFERENCES orchestration_command_receipts(command_id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  provider_instance_id TEXT NOT NULL,
  provider_kind TEXT NOT NULL,
  provider_session_id TEXT,
  delivery_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('pending', 'sending', 'delivered', 'uncertain', 'dismissed', 'failed')
  ),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_provider_turn_outbox_thread_state
ON provider_turn_outbox(thread_id, state, created_at, command_id);

CREATE UNIQUE INDEX idx_provider_turn_outbox_message
ON provider_turn_outbox(message_id);
```

`payload_json` freezes the sanitized message and delivery-affecting route choices so model, mode, effort, and provider settings cannot drift between acceptance and recovery. `delivery_key` is generated once before commit and reused for every Codex/OpenCode attempt.

Add nullable `delivery_state`, `delivery_provider`, and `delivery_detail` columns to `projection_thread_messages`. The initial pending event and later delivery-update events maintain those columns, allowing snapshots and streamed events to expose one optional delivery object on the existing message contract without another projection table.

Retry delay is derived from `attempts` and `updated_at`; no separate scheduler table or lease column is needed for the supported single-process model.

### Attachment references

```sql
CREATE TABLE orchestration_attachment_refs (
  command_id TEXT NOT NULL
    REFERENCES orchestration_command_receipts(command_id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL,
  content_digest TEXT,
  size_bytes INTEGER NOT NULL,
  PRIMARY KEY (command_id, attachment_id)
);

CREATE INDEX idx_orchestration_attachment_refs_attachment
ON orchestration_attachment_refs(attachment_id);
```

`content_digest` is nullable only for migrated legacy references whose persisted event did not retain a digest.

## Attachment Publication and Recovery

The filesystem remains a byte store; SQLite decides durable ownership.

1. Validate attachment count, metadata, rooted paths, sizes, and decoded bytes using the existing `AttachmentMaterializer` checks.
2. Write a uniquely named `.upload` stage and flush it.
3. Publish the final attachment path before the database transaction.
4. Keep the final owned by `PreparedAttachmentBatch` until engine acceptance.
5. In the same SQLite transaction as the turn, insert one attachment-reference row per final file.
6. On successful commit, transfer ownership from the batch to the reference table.

Publishing before the database commit deliberately permits only one inconsistent crash state: an unreferenced final file. It prevents the more dangerous inverse state where committed user history references missing bytes.

Before accepting RPC traffic, startup cleanup runs under the existing attachment-root lock:

- remove stale `.upload` stages;
- enumerate final files under the canonical attachment root;
- remove finals absent from `orchestration_attachment_refs`;
- retain every referenced file, including legacy rows.

Normal unwinding continues to use RAII cleanup. Startup reconciliation is the process-abort backstop.

## Bootstrap and Project Setup

Thread creation, the project-setup request, the user turn, and delivery intent are persisted together. External setup begins only after commit.

Project/worktree setup reuses the existing event and projection lifecycle. Resource names and paths remain deterministic from persisted project/thread identity. An accepted setup therefore belongs to a durable thread even if the client disconnects. Setup completion or failure is persisted before the outbox row becomes eligible for provider delivery.

The outbox dispatcher does not hold a SQLite transaction while creating a worktree, starting a provider session, or sending a prompt.

A provider may create an external session and lose its response before BiBCode records the returned provider session ID. Some providers do not expose a client-selected session ID or exact session-creation reconciliation. This can leave an external orphan session, but it cannot duplicate or lose a locally accepted user turn because the prompt remains in the durable outbox.

## Outbox Dispatcher

### Ownership and scheduling

One dispatcher service is started with the server runtime. It wakes on startup, after new admission, after project setup becomes ready, and after retry delay expiration.

The dispatcher selects only rows for which no earlier unresolved row exists in the same thread. It uses the server's existing Tokio semaphore pattern to bound concurrent sends across different threads. No two rows for one thread are sent concurrently.

Claiming a row atomically changes `pending` to `sending` and increments `attempts`. No SQLite transaction remains open during provider I/O.

### Shared delivery outcomes

Provider adapters return one small shared result enum:

- `Accepted`: provider acknowledgement observed.
- `DefinitelyNotSent`: failure occurred before the request crossed the provider boundary; safe for bounded retry.
- `Ambiguous`: the request may have crossed the boundary.
- `Rejected`: permanent provider rejection or invalid request.

The enum records boundary knowledge, not provider-specific error strings. Existing provider drivers remain responsible for translating their protocol into one outcome.

### State transitions

```text
pending -> sending -> delivered
                   -> pending     (definitely not sent; bounded retry)
                   -> failed      (permanent rejection)
                   -> reconcile   (in-memory action for Codex/OpenCode)
                   -> uncertain   (Claude/Cursor ambiguity)

uncertain -> pending    (explicit manual retry)
          -> dismissed  (acknowledge risk and continue)
          -> delivered  (late correlated provider event)
failed    -> pending    (explicit user retry)
          -> dismissed  (continue without this turn)
dismissed -> delivered  (late correlated provider event)
```

`reconcile` is not a database state. A row left in `sending` after restart is reconciled for Codex/OpenCode and becomes `uncertain` for Claude/Cursor. If the process stops during reconciliation, the row remains `sending` and repeats the same safe decision after restart.

`pending`, `sending`, `uncertain`, and `failed` block later rows in the same thread. `delivered` and `dismissed` are terminal for scheduling. This keeps strict turn order until the user explicitly retries or acknowledges an unresolved turn.

Every user-visible terminal transition is persisted together with its orchestration event/projection update. The UI cannot observe a delivery state that disagrees with the outbox row.

### Shutdown

On graceful shutdown, the dispatcher stops claiming new rows and lets admitted sends finish within the existing runtime shutdown grace. A forced stop can leave a row in `sending`; startup provider-specific recovery handles it.

## Provider-Specific Handling

### Codex

- Send `delivery_key` as `clientUserMessageId` in `turn/start`.
- Treat the normal turn-start response/echo as acceptance.
- For a recovered `sending` row, read the thread with turns included and match the user message's echoed client ID.
- Found means `delivered`; an authoritative completed read without the ID means reset to `pending`.

### OpenCode

- Send `delivery_key` as `messageID` to `POST /session/:id/prompt_async`.
- Treat the accepted asynchronous request as delivery.
- For a recovered `sending` row, request `/session/:id/message/:messageID`.
- Found means `delivered`; an authoritative not-found response means reset to `pending`.

### Claude

- Continue stream-json input and use replayed user-message acknowledgement as the live acceptance signal.
- A definite stdin/process failure before the write is retryable.
- A disconnect or crash after the write begins but before acknowledgement becomes `uncertain`.
- Never automatically resend an uncertain row.

### Cursor

- Continue ACP `session/prompt`.
- A normal response means accepted.
- A connection loss after the request is written but before a response becomes `uncertain` because ACP does not give the client a durable prompt message ID for exact lookup.
- Never automatically resend an uncertain row.

## User Experience

The locally persisted user message appears immediately after SQLite acceptance. Delivery status belongs to the affected turn, not the composer toolbar:

- `pending` or `sending`: keep the existing in-progress treatment.
- `delivered`: normal turn display.
- `failed`: show the provider error with retry and dismiss/continue actions.
- `uncertain`: show `Delivery uncertain`, provider name, and the explanation that automatic retry could duplicate the turn.
- `dismissed`: hide the warning while retaining the durable audit state.

`Retry manually` first reiterates the duplicate risk for an uncertain turn, then resets `attempts` to zero, changes the existing row to immediately eligible `pending`, and records the user action. `Dismiss` changes an uncertain or failed row to `dismissed` and unblocks later turns. A late provider response can still associate with the original turn and advance an uncertain or dismissed row to `delivered` when provider correlation is available.

## MCP Status Actor

Each Codex session runtime owns one MCP status actor task and one bounded Tokio `mpsc` mailbox. Remove the MCP shared mutable lock. All state mutation and `mcp.status.updated` emission occur inside this actor.

### Actor-owned state

- active provider root;
- root epoch;
- refresh generation;
- committed `BTreeMap` of normalized servers;
- staged notification overlay;
- count-bounded pre-root notification queue (existing maximum 64);
- waiters for coalesced refresh calls;
- current load phase.

### Inputs

- `Open` / bind provider root;
- public or reconnect `Refresh`;
- lifecycle `Notification`;
- tagged `LoadFinished` or `LoadFailed`;
- shutdown.

Pagination and JSON-RPC waits run in a spawned loader task, not in the actor. The loader retains the existing page limit, cursor validation, exact official request shape, request cancellation cleanup, and per-page timeout. It returns `(epoch, generation, result)` through the mailbox.

### Refresh behavior

- Before the provider root is known, notifications enter the bounded pre-root queue.
- Binding a root filters buffered notifications to that root.
- While discovery is active, every matching notification changes only the staged overlay. No partial event is emitted.
- On successful discovery, replace the baseline, apply the overlay in arrival order, and emit one complete sorted snapshot.
- On same-root discovery failure, merge the overlay over the last committed baseline, emit the complete snapshot if changed, then emit the warning.
- On changed-root failure, discard the old-root baseline, apply only the new-root overlay, emit the new-root complete snapshot, then emit the warning.
- `session.ready` follows the snapshot/warning completion reply.

An `Open` that changes root increments the epoch and clears old-root state. Results and notifications tagged with an old epoch are ignored.

A public refresh during thread opening joins the active generation and adds a reply waiter. Concurrent same-root refreshes coalesce instead of clearing buffers or starting duplicate list calls. A later same-root refresh can start a new generation while retaining the current map until the replacement commits.

Because the actor performs `state mutation -> event emission -> next mailbox message`, an older captured snapshot cannot publish after a newer one.

## Migration

The migration is intentionally conservative:

1. Add the nullable `payload_digest` column and the two new tables.
2. Backfill `orchestration_attachment_refs` by parsing persisted user-turn event payloads. Preserve IDs and sizes; leave unavailable legacy content digests null.
3. Run attachment garbage collection only after the backfill transaction succeeds.
4. Do not create outbox rows for historical receipts or turns. They may already have reached a provider.
5. Treat a replay of a null-digest legacy receipt as inert: return its stored result and never route current request data.

No destructive history rewrite is required.

## Error Handling

- Invalid command, digest conflict, or attachment validation failure occurs before acceptance and produces no outbox work.
- SQLite admission failure rolls back the entire envelope; the prepared batch remains responsible for normal cleanup.
- Project setup failure is durable and visible; provider delivery waits.
- Retryable pre-send failures use bounded exponential delay derived from persisted attempt count and update time.
- Permanent provider failures are durable and visible.
- Ambiguous Claude/Cursor delivery is durable and visible, with no automatic resend.
- MCP discovery remains best-effort: timeout or schema failure emits a valid complete snapshot where needed, a runtime warning, then permits session readiness.
- Stale MCP loader results and foreign-root notifications are ignored by epoch/root checks.

## Verification Plan

### Command, attachment, and cancellation tests

- Same `commandId` and digest returns the existing receipt without attachment preparation or provider work.
- Same `commandId` and different digest returns conflict; no final files or provider work remain.
- Concurrent duplicate submissions commit exactly one receipt and outbox row.
- A deterministic barrier aborts preparation during an open write/flush and proves cleanup on Windows.
- A subprocess exits after final-file publication but before DB commit; restart removes the orphan final.
- A subprocess exits after DB commit but before provider send; restart delivers the pending row.
- Deterministic barriers cover cancellation before enqueue, during engine admission, and after commit.
- Bootstrap cancellation cannot leave an unowned thread/worktree/setup operation.

### Provider tests

- Codex sends and reconciles the exact stored client message ID.
- OpenCode sends and looks up the exact stored message ID.
- Claude acknowledgement produces `delivered`; post-write disconnect produces `uncertain` and no automatic second write.
- Cursor response produces `delivered`; post-request disconnect produces `uncertain` and no automatic second prompt.
- Per-thread ordering blocks a later row behind every unresolved earlier row.
- Separate threads use bounded parallelism.
- Retry and dismiss actions persist exact state/event transitions.

### MCP tests

- Notifications before root binding, during discovery, and after completion produce only complete snapshots.
- A deterministic multi-thread barrier forces notification/load interleaving; the final event always equals actor state.
- A changed-root failure with distinct `old-only` and `new-only` names never re-emits `old-only`.
- Manual refresh during open joins the current generation and preserves buffered observations.
- Concurrent refresh calls issue one bounded discovery sequence.
- Stale loader results cannot mutate or emit.
- Success, authoritative empty, failure, and timeout paths assert exact snapshot/warning/ready order.

### Repository gates

- Focused Rust and web tests for every new boundary.
- `vp test`
- `vp check`
- `vp run typecheck`
- `git diff --check`

## Implementation Boundaries

The implementation should reuse existing modules and keep the diff local:

- orchestration migrations/repositories and engine admission;
- production orchestration RPC wiring;
- attachment materialization/startup reconciliation;
- provider runtime supervisor and the four provider adapters;
- Codex MCP runtime state;
- orchestration/provider contracts and chat turn rendering;
- focused unit/integration/subprocess tests.

Do not add a general outbox crate, actor framework, scheduler, or new dependency. Use existing SQLite transactions, Tokio tasks/channels/semaphore patterns, and provider runtime structures.

## Research Basis

The design was checked against primary documentation on 2026-08-01:

- SQLite transaction semantics and crash-safe commit: [Transactions](https://www.sqlite.org/lang_transaction.html), [Atomic Commit](https://www.sqlite.org/atomiccommit.html), and [Transactional SQLite](https://www.sqlite.org/transactional.html).
- Transactional outbox behavior and the need for consumer idempotency: [AWS Prescriptive Guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html) and [Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/databases/guide/transactional-out-box-cosmos).
- Tokio's dedicated state-owner task and channel pattern: [`tokio::sync`](https://docs.rs/tokio/latest/tokio/sync/index.html), [`mpsc`](https://docs.rs/tokio/latest/tokio/sync/mpsc/index.html), and cancellation behavior of [`select!`](https://docs.rs/tokio/latest/tokio/macro.select.html).
- Codex app-server `turn/start`, `clientUserMessageId`, and thread readback: [Codex app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md).
- OpenCode asynchronous prompt and message APIs: [OpenCode server documentation](https://dev.opencode.ai/docs/server/).
- Claude stream-json input and replay acknowledgement: [Claude Code CLI reference](https://code.claude.com/docs/en/cli-usage).
- ACP message ownership and message-ID limits used by Cursor: [ACP message ID RFD](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/rfds/message-id.mdx) and [ACP prompt RFD](https://agentclientprotocol.com/rfds/v2/prompt).

## Approved Decisions

- Use the SQLite outbox plus filesystem attachments approach.
- Support Codex, Claude, OpenCode, and Cursor.
- Use automatic reconciliation only for Codex and OpenCode.
- Show a durable `Delivery uncertain` state for ambiguous Claude/Cursor sends.
- Use one MCP actor as the only state mutator and event publisher.
- Keep the one-server-process-per-state-root ceiling.
- Preserve a simple composer toolbar with no agent selector.
