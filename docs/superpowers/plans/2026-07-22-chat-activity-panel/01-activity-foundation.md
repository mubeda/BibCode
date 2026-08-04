# Chat Activity Dock — Activity Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the bounded activity contracts, durable server projection, authenticated snapshot/delta RPC, provider-event plumbing, and reconnecting client reducer required by every provider and UI surface.

**Architecture:** Store a normalized per-scope journal plus materialized actor/work-item/entry rows in SQLite. `ActivityProjection` serializes and validates mutation batches, increments a scope-local revision transactionally, and broadcasts deltas. The client follows one durable stream per activity scope and replaces state from a snapshot whenever a revision gap appears.

**Tech Stack:** Effect Schema, Effect Streams/SubscriptionRef, TypeScript, Rust/Serde/Tokio, rusqlite, Vite+ tests, Cargo tests.

## Global Constraints

- Read [00-overview.md](./00-overview.md) and the approved design before starting.
- Read `.repos/effect-smol/LLMS.md` completely before editing Effect code.
- `packages/contracts` remains schema-only.
- Activity is current-scope and read-only.
- All payloads are bounded; unknown provider JSON does not cross the RPC unchanged.
- A delta applies only when `previousRevision` equals the client's current revision.
- Duplicate native event keys are no-ops and do not increment revision.
- Terminal lifecycle states cannot regress from late events.
- Run `vp check` and `vp run typecheck` before the complete suite is declared finished.

---

## Task 1: Define the bounded activity wire contract and RPC tags

**Files:**

- Create: `packages/contracts/src/activity.ts`
- Create: `packages/contracts/src/activity.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/environment.ts`
- Create: `packages/contracts/src/environment.test.ts`
- Modify: `packages/contracts/src/rpc.ts`
- Modify: `packages/contracts/src/rpc.test.ts`
- Modify: `packages/contracts/src/rpcRustParity.test.ts`
- Modify: `packages/contracts/scripts/export-rust-rpc-fixtures.ts`
- Modify: `packages/contracts/fixtures/rpc-wire/manifest.json`

**Interfaces:**

- Produces: every `Activity*` schema/type named below.
- Produces RPC tags: `activity.getSnapshot`, `activity.listRoster`, `activity.listDetail`, and `subscribeActivity`.
- Consumed by: Tasks 2–5 and every later plan.

- [ ] **Step 1: Write failing schema tests**

Create `packages/contracts/src/activity.test.ts` with these cases:

```ts
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  ActivityDelta,
  ActivityDetailPage,
  ActivityScopeRef,
  ActivitySnapshot,
  ActivityStreamItem,
} from "./activity.ts";

const actor = {
  _tag: "actor" as const,
  id: "actor:child-1",
  parentActorId: null,
  name: "Explore provider events",
  role: "explorer",
  providerType: "worker",
  status: "running" as const,
  summary: "Reading App Server schemas",
  startedAt: "2026-07-22T12:00:00Z",
  updatedAt: "2026-07-22T12:00:01Z",
  terminalAt: null,
};

const snapshot = {
  protocolVersion: 1 as const,
  scopeId: "thread:thread-1",
  scope: { _tag: "thread" as const, threadId: "thread-1" },
  revision: 3,
  provider: "codex",
  providerInstanceId: "codex",
  capabilities: {
    actors: true,
    attributedActivity: true,
    backgroundWork: true,
    historyRecovery: "full" as const,
    terminalObservation: false,
  },
  observationState: "live" as const,
  sections: {
    subagents: { state: "live" as const, message: null, retryable: false },
    backgroundTasks: { state: "live" as const, message: null, retryable: false },
  },
  counts: {
    subagents: { active: 1, done: 0 },
    backgroundTasks: { active: 0, done: 0 },
  },
  actors: [actor],
  workItems: [],
  actorsHasMore: false,
  workItemsHasMore: false,
  updatedAt: "2026-07-22T12:00:01Z",
};

describe("activity contracts", () => {
  it("round-trips a thread scope snapshot and stream item", () => {
    expect(Schema.decodeUnknownSync(ActivityScopeRef)(snapshot.scope)).toEqual(snapshot.scope);
    expect(Schema.decodeUnknownSync(ActivitySnapshot)(snapshot)).toEqual(snapshot);
    expect(
      Schema.decodeUnknownSync(ActivityStreamItem)({ kind: "snapshot", snapshot }),
    ).toEqual({ kind: "snapshot", snapshot });
  });

  it("round-trips an ordered actor delta", () => {
    const delta = {
      scopeId: snapshot.scopeId,
      previousRevision: 3,
      revision: 4,
      changes: [{ kind: "actor-upserted" as const, actor }],
      updatedAt: "2026-07-22T12:00:02Z",
    };
    expect(Schema.decodeUnknownSync(ActivityDelta)(delta)).toEqual(delta);
  });

  it("rejects oversized labels and invalid revisions", () => {
    expect(() =>
      Schema.decodeUnknownSync(ActivitySnapshot)({
        ...snapshot,
        revision: -1,
        actors: [{ ...actor, name: "x".repeat(257) }],
      }),
    ).toThrow();
  });

  it("bounds detail entries and cursors", () => {
    expect(() =>
      Schema.decodeUnknownSync(ActivityDetailPage)({
        record: actor,
        entries: Array.from({ length: 201 }, (_, index) => ({
          id: `entry:${index}`,
          ownerKind: "actor",
          ownerId: actor.id,
          kind: "commentary",
          title: "Update",
          detail: "Working",
          tone: "info",
          createdAt: "2026-07-22T12:00:02Z",
        })),
        nextCursor: "x".repeat(513),
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Add failing RPC tag assertions**

In `packages/contracts/src/rpc.test.ts`, import the new RPC values and add:

```ts
expect(WS_METHODS.activityGetSnapshot).toBe("activity.getSnapshot");
expect(WS_METHODS.activityListRoster).toBe("activity.listRoster");
expect(WS_METHODS.activityListDetail).toBe("activity.listDetail");
expect(WS_METHODS.subscribeActivity).toBe("subscribeActivity");
expect(WsActivityGetSnapshotRpc._tag).toBe(WS_METHODS.activityGetSnapshot);
expect(WsSubscribeActivityRpc._tag).toBe(WS_METHODS.subscribeActivity);
```

Add the four methods to the generated Rust fixture and parity expectations.

- [ ] **Step 3: Run the focused contract tests and verify the red state**

```bash
vp test run packages/contracts/src/activity.test.ts packages/contracts/src/rpc.test.ts packages/contracts/src/rpcRustParity.test.ts
```

Expected: FAIL because `activity.ts` and the four RPC exports do not exist.

- [ ] **Step 4: Implement `activity.ts`**

Use the following exact public surface. Keep helper schemas private unless they
are named here:

```ts
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const ACTIVITY_ID_MAX_LENGTH = 256;
export const ACTIVITY_LABEL_MAX_LENGTH = 256;
export const ACTIVITY_SUMMARY_MAX_LENGTH = 2_048;
export const ACTIVITY_DETAIL_MAX_LENGTH = 16_384;
export const ACTIVITY_CURSOR_MAX_LENGTH = 512;
export const ACTIVITY_PAGE_MAX_LENGTH = 200;

const ActivityId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(ACTIVITY_ID_MAX_LENGTH),
);
const ActivityLabel = TrimmedNonEmptyString.check(
  Schema.isMaxLength(ACTIVITY_LABEL_MAX_LENGTH),
);
const ActivitySummaryText = Schema.String.check(
  Schema.isMaxLength(ACTIVITY_SUMMARY_MAX_LENGTH),
);
const ActivityDetailText = Schema.String.check(
  Schema.isMaxLength(ACTIVITY_DETAIL_MAX_LENGTH),
);
export const ActivityScopeId = ActivityId.pipe(Schema.brand("ActivityScopeId"));
export type ActivityScopeId = typeof ActivityScopeId.Type;
export const ActivityRecordId = ActivityId.pipe(Schema.brand("ActivityRecordId"));
export type ActivityRecordId = typeof ActivityRecordId.Type;
export const ActivityEntryId = ActivityId.pipe(Schema.brand("ActivityEntryId"));
export type ActivityEntryId = typeof ActivityEntryId.Type;

export const ActivitySection = Schema.Literals(["subagents", "backgroundTasks"]);
export type ActivitySection = typeof ActivitySection.Type;
export const ActivityRecordKind = Schema.Literals(["actor", "workItem"]);
export type ActivityRecordKind = typeof ActivityRecordKind.Type;
export const ActivityLifecycle = Schema.Literals([
  "starting",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "unknown",
]);
export type ActivityLifecycle = typeof ActivityLifecycle.Type;
export const ActivityObservationState = Schema.Literals([
  "live",
  "reconnecting",
  "stale",
  "error",
]);
export type ActivityObservationState = typeof ActivityObservationState.Type;

export const ActivitySectionObservationState = Schema.Literals([
  "unsupported",
  "live",
  "stale",
  "error",
]);
export type ActivitySectionObservationState =
  typeof ActivitySectionObservationState.Type;

export const ActivitySectionHealth = Schema.Struct({
  state: ActivitySectionObservationState,
  message: Schema.NullOr(ActivitySummaryText),
  retryable: Schema.Boolean,
});
export type ActivitySectionHealth = typeof ActivitySectionHealth.Type;

export const ActivitySectionHealthMap = Schema.Struct({
  subagents: ActivitySectionHealth,
  backgroundTasks: ActivitySectionHealth,
});
export type ActivitySectionHealthMap = typeof ActivitySectionHealthMap.Type;

export const ActivityScopeRef = Schema.Union([
  Schema.TaggedStruct("thread", { threadId: ThreadId }),
  Schema.TaggedStruct("terminal", {
    threadId: ThreadId,
    terminalId: ActivityId,
  }),
]);
export type ActivityScopeRef = typeof ActivityScopeRef.Type;

export const ActivityCapabilities = Schema.Struct({
  actors: Schema.Boolean,
  attributedActivity: Schema.Boolean,
  backgroundWork: Schema.Boolean,
  historyRecovery: Schema.Literals(["full", "bounded", "none"]),
  terminalObservation: Schema.Boolean,
});
export type ActivityCapabilities = typeof ActivityCapabilities.Type;

export const NO_ACTIVITY_CAPABILITIES = {
  actors: false,
  attributedActivity: false,
  backgroundWork: false,
  historyRecovery: "none",
  terminalObservation: false,
} as const satisfies ActivityCapabilities;

const ActivityRecordBase = {
  id: ActivityRecordId,
  name: ActivityLabel,
  status: ActivityLifecycle,
  summary: Schema.NullOr(ActivitySummaryText),
  startedAt: IsoDateTime,
  updatedAt: IsoDateTime,
  terminalAt: Schema.NullOr(IsoDateTime),
};

export const ActivityActorSummary = Schema.TaggedStruct("actor", {
  ...ActivityRecordBase,
  parentActorId: Schema.NullOr(ActivityRecordId),
  role: Schema.NullOr(ActivityLabel),
  providerType: Schema.NullOr(ActivityLabel),
});
export type ActivityActorSummary = typeof ActivityActorSummary.Type;

export const ActivityWorkItemSummary = Schema.TaggedStruct("workItem", {
  ...ActivityRecordBase,
  ownerActorId: Schema.NullOr(ActivityRecordId),
  workKind: ActivityLabel,
  command: Schema.NullOr(ActivityDetailText),
  cwd: Schema.NullOr(ActivityDetailText),
});
export type ActivityWorkItemSummary = typeof ActivityWorkItemSummary.Type;

export const ActivityRecordSummary = Schema.Union([
  ActivityActorSummary,
  ActivityWorkItemSummary,
]);
export type ActivityRecordSummary = typeof ActivityRecordSummary.Type;

export const ActivityEntry = Schema.Struct({
  id: ActivityEntryId,
  ownerKind: ActivityRecordKind,
  ownerId: ActivityRecordId,
  kind: Schema.Literals([
    "commentary",
    "tool",
    "command",
    "result",
    "error",
    "state",
    "completion",
  ]),
  title: ActivityLabel,
  detail: Schema.NullOr(ActivityDetailText),
  tone: Schema.Literals(["info", "tool", "success", "warning", "error"]),
  createdAt: IsoDateTime,
});
export type ActivityEntry = typeof ActivityEntry.Type;

const ActivityCounts = Schema.Struct({ active: NonNegativeInt, done: NonNegativeInt });
export const ActivitySummaryCounts = Schema.Struct({
  subagents: ActivityCounts,
  backgroundTasks: ActivityCounts,
});
export type ActivitySummaryCounts = typeof ActivitySummaryCounts.Type;

export const ActivitySnapshot = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  scopeId: ActivityScopeId,
  scope: ActivityScopeRef,
  revision: NonNegativeInt,
  provider: ProviderDriverKind,
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  capabilities: ActivityCapabilities,
  observationState: ActivityObservationState,
  sections: ActivitySectionHealthMap,
  counts: ActivitySummaryCounts,
  actors: Schema.Array(ActivityActorSummary).check(
    Schema.isMaxLength(ACTIVITY_PAGE_MAX_LENGTH),
  ),
  workItems: Schema.Array(ActivityWorkItemSummary).check(
    Schema.isMaxLength(ACTIVITY_PAGE_MAX_LENGTH),
  ),
  actorsHasMore: Schema.Boolean,
  workItemsHasMore: Schema.Boolean,
  updatedAt: IsoDateTime,
});
export type ActivitySnapshot = typeof ActivitySnapshot.Type;

export const ActivityChange = Schema.Union([
  Schema.TaggedStruct("scope-updated", {
    capabilities: ActivityCapabilities,
    observationState: ActivityObservationState,
    sections: ActivitySectionHealthMap,
    counts: ActivitySummaryCounts,
  }),
  Schema.TaggedStruct("actor-upserted", { actor: ActivityActorSummary }),
  Schema.TaggedStruct("actor-removed", { actorId: ActivityRecordId }),
  Schema.TaggedStruct("work-item-upserted", { workItem: ActivityWorkItemSummary }),
  Schema.TaggedStruct("work-item-removed", { workItemId: ActivityRecordId }),
  Schema.TaggedStruct("entry-appended", { entry: ActivityEntry }),
]);
export type ActivityChange = typeof ActivityChange.Type;

export const ActivityDelta = Schema.Struct({
  scopeId: ActivityScopeId,
  previousRevision: NonNegativeInt,
  revision: PositiveInt,
  changes: Schema.Array(ActivityChange).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  updatedAt: IsoDateTime,
});
export type ActivityDelta = typeof ActivityDelta.Type;

export const ActivityStreamItem = Schema.Union([
  Schema.TaggedStruct("snapshot", { snapshot: ActivitySnapshot }),
  Schema.TaggedStruct("delta", { delta: ActivityDelta }),
]);
export type ActivityStreamItem = typeof ActivityStreamItem.Type;

const ActivityPageCursor = ActivityId.check(Schema.isMaxLength(ACTIVITY_CURSOR_MAX_LENGTH));
const ActivityPageLimit = Schema.optional(
  PositiveInt.check(Schema.isLessThanOrEqualTo(ACTIVITY_PAGE_MAX_LENGTH)),
);
export const ActivityGetSnapshotInput = ActivityScopeRef;
export const ActivityListRosterInput = Schema.Struct({
  scopeId: ActivityScopeId,
  section: ActivitySection,
  bucket: Schema.Literals(["active", "done"]),
  cursor: Schema.optional(ActivityPageCursor),
  limit: ActivityPageLimit,
});
export const ActivityRosterPage = Schema.Struct({
  records: Schema.Array(ActivityRecordSummary).check(
    Schema.isMaxLength(ACTIVITY_PAGE_MAX_LENGTH),
  ),
  nextCursor: Schema.NullOr(ActivityPageCursor),
});
export const ActivityListDetailInput = Schema.Struct({
  scopeId: ActivityScopeId,
  recordKind: ActivityRecordKind,
  recordId: ActivityRecordId,
  cursor: Schema.optional(ActivityPageCursor),
  limit: ActivityPageLimit,
});
export const ActivityDetailPage = Schema.Struct({
  record: ActivityRecordSummary,
  entries: Schema.Array(ActivityEntry).check(Schema.isMaxLength(ACTIVITY_PAGE_MAX_LENGTH)),
  nextCursor: Schema.NullOr(ActivityPageCursor),
});
export class ActivityError extends Schema.TaggedErrorClass<ActivityError>()("ActivityError", {
  message: ActivitySummaryText,
  reason: Schema.Literals(["notFound", "invalidScope", "invalidCursor", "internal"]),
}) {}
```

Export `activity.ts` from `index.ts`.

Extend `ExecutionEnvironmentCapabilities` with the additive negotiation gate:

```ts
activityProtocolVersion: Schema.NullOr(Schema.Literal(1)).pipe(
  Schema.withDecodingDefault(Effect.succeed(null)),
),
```

Add environment contract tests proving an old descriptor decodes this as null
and a server descriptor can advertise version 1. The client must not open an
activity stream when this capability is null.

- [ ] **Step 5: Add the four RPC definitions**

Import the activity schemas in `rpc.ts`, add the four `WS_METHODS` keys, and
add these definitions to `WsRpcGroup`:

```ts
export const WsActivityGetSnapshotRpc = Rpc.make(WS_METHODS.activityGetSnapshot, {
  payload: ActivityGetSnapshotInput,
  success: ActivitySnapshot,
  error: Schema.Union([ActivityError, EnvironmentAuthorizationError]),
});
export const WsActivityListRosterRpc = Rpc.make(WS_METHODS.activityListRoster, {
  payload: ActivityListRosterInput,
  success: ActivityRosterPage,
  error: Schema.Union([ActivityError, EnvironmentAuthorizationError]),
});
export const WsActivityListDetailRpc = Rpc.make(WS_METHODS.activityListDetail, {
  payload: ActivityListDetailInput,
  success: ActivityDetailPage,
  error: Schema.Union([ActivityError, EnvironmentAuthorizationError]),
});
export const WsSubscribeActivityRpc = Rpc.make(WS_METHODS.subscribeActivity, {
  payload: ActivityScopeRef,
  success: ActivityStreamItem,
  error: Schema.Union([ActivityError, EnvironmentAuthorizationError]),
  stream: true,
});
```

Regenerate the Rust RPC fixture with the repository script rather than editing
generated JSON by hand:

```bash
vp run --filter @bibcode/contracts generate:rust-rpc-fixtures
```

- [ ] **Step 6: Run focused tests and typecheck**

```bash
vp test run packages/contracts/src/activity.test.ts packages/contracts/src/environment.test.ts \
  packages/contracts/src/rpc.test.ts packages/contracts/src/rpcRustParity.test.ts
vp run --filter @bibcode/contracts typecheck
```

Expected: PASS and clean typecheck.

- [ ] **Step 7: Commit the activity contract**

```bash
git add packages/contracts/src/activity.ts packages/contracts/src/activity.test.ts \
  packages/contracts/src/index.ts packages/contracts/src/environment.ts \
  packages/contracts/src/environment.test.ts packages/contracts/src/rpc.ts \
  packages/contracts/src/rpc.test.ts packages/contracts/src/rpcRustParity.test.ts \
  packages/contracts/scripts/export-rust-rpc-fixtures.ts packages/contracts/fixtures/rpc-wire
git commit -m "feat(activity): add bounded activity protocol"
```

---

## Task 2: Add the activity journal and materialized repository

**Files:**

- Modify: `apps/server/src/persistence/migrations.rs`
- Create: `apps/server/src/activity/repository.rs`
- Create: `apps/server/src/activity/model.rs`
- Create: `apps/server/src/activity/mod.rs`
- Modify: `apps/server/src/lib.rs`
- Create: `apps/server/tests/activity_repository.rs`

**Interfaces:**

- Consumes: Task 1 wire names and lifecycle values.
- Produces: `ActivityRepository::{ensure_scope, apply_batch, snapshot, list_roster, list_detail}`.
- Produces: `ActivityScopeSeed`, `ProviderActivityMutation`, and Rust wire structs.

- [ ] **Step 1: Write the failing migration/repository test**

Create `apps/server/tests/activity_repository.rs`. The test must open an
in-memory database, run every migration, and prove duplicate-native-event and
terminal-state behavior:

```rust
#[tokio::test]
async fn activity_batches_are_durable_idempotent_and_terminal_monotonic() {
    let database = Database::open_in_memory().await.expect("database");
    database.call(|connection| run_migrations(connection, None).map(|_| ()))
        .await.expect("migrations");
    let repository = ActivityRepository::new(database);
    let scope = ActivityScopeSeed::thread(
        "thread:thread-1", "thread-1", "codex", Some("codex"),
        ActivityCapabilities::structured_full(true),
    );

    repository.ensure_scope(scope.clone()).await.expect("scope");
    let first = repository.apply_batch(
        &scope.scope_id,
        "codex:item:1",
        vec![ProviderActivityMutation::upsert_actor(
            "actor:child-1", None, "Explore", "running",
        )],
        "2026-07-22T12:00:00Z",
    ).await.expect("batch").expect("new delta");
    assert_eq!((first.previous_revision, first.revision), (0, 1));

    assert!(repository.apply_batch(
        &scope.scope_id,
        "codex:item:1",
        vec![ProviderActivityMutation::remove_actor("actor:child-1")],
        "2026-07-22T12:00:01Z",
    ).await.expect("duplicate").is_none());

    repository.apply_batch(
        &scope.scope_id,
        "codex:item:2",
        vec![ProviderActivityMutation::set_actor_status("actor:child-1", "completed")],
        "2026-07-22T12:00:02Z",
    ).await.expect("complete");
    assert!(repository.apply_batch(
        &scope.scope_id,
        "codex:item:late",
        vec![ProviderActivityMutation::set_actor_status("actor:child-1", "running")],
        "2026-07-22T12:00:01Z",
    ).await.expect("late").is_none());

    let snapshot = repository.snapshot(&ActivityScopeRef::Thread {
        thread_id: "thread-1".to_owned(),
    }).await.expect("snapshot");
    assert_eq!(snapshot.revision, 2);
    assert_eq!(snapshot.actors[0].status, ActivityLifecycle::Completed);
}
```

- [ ] **Step 2: Run the test and verify the red state**

```bash
cargo test -p bibcode-server --test activity_repository
```

Expected: FAIL because the activity module and migration do not exist.

- [ ] **Step 3: Add migration 34**

Append `Migration::new(34, "ActivityProjection", migration_034)` and implement
the exact table responsibilities below:

```rust
fn migration_034(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        CREATE TABLE activity_scopes (
          scope_id TEXT PRIMARY KEY NOT NULL,
          source_kind TEXT NOT NULL CHECK(source_kind IN ('thread', 'terminal')),
          thread_id TEXT NOT NULL,
          terminal_id TEXT,
          generation_id TEXT NOT NULL,
          is_current INTEGER NOT NULL DEFAULT 1 CHECK(is_current IN (0, 1)),
          provider_name TEXT NOT NULL,
          provider_instance_id TEXT,
          capabilities_json TEXT NOT NULL,
          observation_state TEXT NOT NULL,
          section_health_json TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX idx_activity_scopes_one_current
          ON activity_scopes(thread_id, source_kind, COALESCE(terminal_id, ''))
          WHERE is_current = 1;
        CREATE INDEX idx_activity_scopes_lookup
          ON activity_scopes(thread_id, source_kind, terminal_id, is_current, updated_at DESC);

        CREATE TABLE activity_records (
          scope_id TEXT NOT NULL REFERENCES activity_scopes(scope_id) ON DELETE CASCADE,
          record_kind TEXT NOT NULL CHECK(record_kind IN ('actor', 'workItem')),
          record_id TEXT NOT NULL,
          parent_actor_id TEXT,
          owner_actor_id TEXT,
          status TEXT NOT NULL,
          native_sort_key TEXT NOT NULL,
          summary_json TEXT NOT NULL,
          started_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          terminal_at TEXT,
          PRIMARY KEY(scope_id, record_kind, record_id)
        );
        CREATE INDEX idx_activity_records_roster
          ON activity_records(scope_id, record_kind, status, updated_at DESC, record_id DESC);

        CREATE TABLE activity_entries (
          scope_id TEXT NOT NULL REFERENCES activity_scopes(scope_id) ON DELETE CASCADE,
          entry_id TEXT NOT NULL,
          owner_kind TEXT NOT NULL CHECK(owner_kind IN ('actor', 'workItem')),
          owner_id TEXT NOT NULL,
          native_sort_key TEXT NOT NULL,
          entry_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(scope_id, entry_id)
        );
        CREATE INDEX idx_activity_entries_detail
          ON activity_entries(scope_id, owner_kind, owner_id, created_at DESC, entry_id DESC);

        CREATE TABLE activity_journal (
          scope_id TEXT NOT NULL REFERENCES activity_scopes(scope_id) ON DELETE CASCADE,
          revision INTEGER NOT NULL,
          native_event_key TEXT NOT NULL,
          delta_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(scope_id, revision),
          UNIQUE(scope_id, native_event_key)
        );
        "#,
    )
}
```

- [ ] **Step 4: Implement canonical Rust models**

In `activity/model.rs`, mirror Task 1 with Serde `camelCase` and tagged enums.
Add these internal mutation interfaces exactly:

```rust
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActivityScopeSeed {
    pub scope_id: String,
    pub generation_id: String,
    pub scope: ActivityScopeRef,
    pub provider: String,
    pub provider_instance_id: Option<String>,
    pub capabilities: ActivityCapabilities,
    pub sections: ActivitySectionHealthMap,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ProviderActivityMutation {
    SetScope {
        capabilities: ActivityCapabilities,
        observation_state: ActivityObservationState,
    },
    SetSectionHealth {
        section: ActivitySection,
        health: ActivitySectionHealth,
    },
    UpsertActor(ActivityActorSummary),
    RemoveActor { actor_id: String },
    UpsertWorkItem(ActivityWorkItemSummary),
    RemoveWorkItem { work_item_id: String },
    AppendEntry(ActivityEntry),
}

impl ActivityLifecycle {
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled | Self::Interrupted)
    }
}
```

Provide constructors used by tests and adapters; constructors trim labels,
set timestamps explicitly, and return `Result` when bounds fail. Do not hide
invalid provider data behind truncation except for display summaries explicitly
documented as truncatable.

`ActivityScopeSeed` constructors derive initial section health: a negotiated
section starts `live`; an unnegotiated section starts `unsupported`. A transient
failure changes only that section to `stale` or `error`. A permanent
incompatibility with no retained records becomes `unsupported`; if records were
previously observed, keep them and expose the section as `stale` with a bounded
message.

`ensure_scope` is idempotent by `scope_id`. When a new terminal generation is
inserted, one transaction first marks the previous logical
`(thread_id, terminal_id)` scope non-current, marks unresolved active records
interrupted, then inserts the new current scope. The partial unique index makes
concurrent double-current generations impossible.

- [ ] **Step 5: Implement `ActivityRepository` transactionally**

`apply_batch` must execute one SQLite transaction:

1. reject an empty batch;
2. return `Ok(None)` when `(scope_id, native_event_key)` already exists;
3. load the current revision;
4. validate every parent/owner belongs to the same scope;
5. validate section/capability invariants and bounded section messages;
6. apply mutations in order;
7. ignore a non-terminal upsert older than an existing terminal record;
8. return `Ok(None)` without a journal row if validation leaves no effective changes;
9. calculate exact active/done counts;
10. insert one journal row containing the emitted delta;
11. update the scope revision/timestamp; and
12. commit before returning `Some(delta)`.

Use cursor payloads encoded as URL-safe base64 JSON containing only the last
`updated_at` and `record_id`/`entry_id`; reject malformed cursors as
`ActivityRepositoryError::InvalidCursor`.

The key status predicate is shared by count and roster queries:

```rust
const ACTIVE_STATUSES: &[&str] = &["starting", "running", "waiting", "unknown"];
const DONE_STATUSES: &[&str] = &["completed", "failed", "cancelled", "interrupted"];
```

Return at most `limit.min(200)` rows and fetch `limit + 1` internally to derive
`next_cursor` without a separate count query.

- [ ] **Step 6: Rerun repository and migration tests**

```bash
cargo test -p bibcode-server --test activity_repository
cargo test -p bibcode-server persistence::migrations::tests
```

Expected: PASS.

- [ ] **Step 7: Commit the durable repository**

```bash
git add apps/server/src/persistence/migrations.rs apps/server/src/activity \
  apps/server/src/lib.rs apps/server/tests/activity_repository.rs
git commit -m "feat(activity): persist activity projection"
```

---

## Task 3: Add `ActivityProjection` and authenticated RPC handlers

**Files:**

- Create: `apps/server/src/activity/projection.rs`
- Create: `apps/server/src/activity/rpc.rs`
- Modify: `apps/server/src/activity/mod.rs`
- Modify: `apps/server/src/production/runtime.rs`
- Modify: `apps/server/src/production/control.rs`
- Modify: `apps/server/tests/production_control.rs`
- Modify: `apps/server/src/rpc/methods.rs`
- Modify: `apps/server/src/auth/scope.rs`
- Modify: `packages/client-runtime/src/rpc/client.ts`
- Create: `apps/server/tests/activity_rpc.rs`
- Modify: `apps/server/tests/rpc_wire.rs`

**Interfaces:**

```rust
impl ActivityProjection {
    pub fn new(repository: ActivityRepository) -> Self;
    pub async fn ensure_scope(&self, seed: ActivityScopeSeed) -> Result<(), ActivityError>;
    pub async fn apply(
        &self,
        scope_id: &str,
        native_event_key: String,
        mutations: Vec<ProviderActivityMutation>,
        created_at: String,
    ) -> Result<Option<ActivityDelta>, ActivityError>;
    pub fn subscribe(&self) -> broadcast::Receiver<ActivityDelta>;
}
```

- [ ] **Step 1: Write failing RPC tests**

Create `apps/server/tests/activity_rpc.rs` with tests that:

- register the activity handlers against an in-memory migrated database;
- call `activity.getSnapshot` for a thread scope;
- page active and done rosters independently;
- page detail entries newest-first;
- subscribe and assert the first chunk is a snapshot;
- apply one mutation and assert the next chunk is a delta;
- force broadcast lag with a tiny test capacity and assert the next chunk is a replacement snapshot;
- request a terminal scope belonging to another thread and receive `invalidScope`; and
- verify all four methods require `orchestration:read`.

Use a deterministic `ActivityProjection::with_capacity(repository, 2)` test
constructor so lag is testable without timing assumptions.

- [ ] **Step 2: Run the tests and verify the red state**

```bash
cargo test -p bibcode-server --test activity_rpc
cargo test -p bibcode-server --test rpc_wire
```

Expected: FAIL because the handlers and active method declarations do not exist.

- [ ] **Step 3: Implement the projection service**

Use one broadcast channel and rely on the single SQLite worker transaction for
serialization. Publish only after `repository.apply_batch` commits:

```rust
#[derive(Clone)]
pub struct ActivityProjection {
    repository: ActivityRepository,
    deltas: broadcast::Sender<ActivityDelta>,
}

impl ActivityProjection {
    pub async fn apply(
        &self,
        scope_id: &str,
        native_event_key: String,
        mutations: Vec<ProviderActivityMutation>,
        created_at: String,
    ) -> Result<Option<ActivityDelta>, ActivityError> {
        let delta = self.repository
            .apply_batch(scope_id, native_event_key, mutations, created_at)
            .await?;
        if let Some(delta) = delta.as_ref() {
            let _ = self.deltas.send(delta.clone());
        }
        Ok(delta)
    }
}
```

- [ ] **Step 4: Register the four RPC handlers**

`register_activity_rpc` receives `ActivityProjection`. Unary handlers decode
typed Serde inputs and map repository errors to:

```json
{"_tag":"ActivityError","message":"…","reason":"notFound|invalidScope|invalidCursor|internal"}
```

The stream handler sends a snapshot first, filters deltas by `scope_id`, and
sends a fresh snapshot after `broadcast::error::RecvError::Lagged(_)`.
Cancellation ends its Tokio task immediately.

Register the four names in `ACTIVE_RPC_METHODS` and map all four to
`SCOPE_ORCHESTRATION_READ` in `auth/scope.rs`.

Instantiate once in `ProductionServerRuntime::new`, using
`ActivityRepository::new(repositories.database().clone())`, register the RPC,
and retain a clone for provider and terminal plumbing.

- [ ] **Step 5: Allow the durable client to subscribe**

Add `typeof WS_METHODS.subscribeActivity` to
`EnvironmentSubscriptionRpcTag` in
`packages/client-runtime/src/rpc/client.ts`. The three unary methods are
included automatically through `EnvironmentUnaryRpcTag`.

- [ ] **Step 6: Run focused server and client type tests**

```bash
cargo test -p bibcode-server --test activity_rpc
cargo test -p bibcode-server --test rpc_wire
vp run --filter @bibcode/client-runtime typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit the service and RPC**

```bash
git add apps/server/src/activity apps/server/src/production/runtime.rs \
  apps/server/src/rpc/methods.rs apps/server/src/auth/scope.rs \
  apps/server/tests/activity_rpc.rs apps/server/tests/rpc_wire.rs \
  packages/client-runtime/src/rpc/client.ts
git commit -m "feat(activity): stream activity snapshots and deltas"
```

---

## Task 4: Plumb normalized provider mutations through the supervisor

**Files:**

- Modify: `apps/server/src/production/provider_runtime.rs`
- Modify: `apps/server/src/production/runtime.rs`
- Modify: `apps/server/tests/production_provider_runtime.rs`
- Modify: `apps/server/src/production/operational_logs.rs`

**Interfaces:**

- Produces `ProviderEvent.native_event_id` and `ProviderEvent.activity`.
- Produces `StartedSession.activity_capabilities`.
- Later provider plans populate these values; this task keeps all providers at `NO_ACTIVITY_CAPABILITIES` and empty mutations.

- [ ] **Step 1: Add failing supervisor tests**

Extend `production_provider_runtime.rs` with a fake driver that returns:

```rust
StartedSession {
    resume_cursor: Some(json!({"sessionId":"native-1"})),
    runtime_payload: None,
    activity_capabilities: ActivityCapabilities::structured_full(false),
}
```

and then emits:

```rust
ProviderEvent {
    native_event_id: Some("native:event:1".to_owned()),
    event_type: "activity.native".to_owned(),
    thread_id: "thread-1".to_owned(),
    turn_id: None,
    request_id: None,
    payload: json!({}),
    activity: vec![ProviderActivityMutation::upsert_actor(
        "actor:child", None, "Child", "running",
    )],
}
```

Assert the scope is created during launch, the mutation appears in the activity
snapshot, and replaying the same native event leaves the revision unchanged.

- [ ] **Step 2: Run the focused test and verify the red state**

```bash
cargo test -p bibcode-server --test production_provider_runtime activity
```

Expected: FAIL because the fields and projection dependency are missing.

- [ ] **Step 3: Extend the provider transport structs**

```rust
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct StartedSession {
    pub resume_cursor: Option<Value>,
    pub runtime_payload: Option<Value>,
    pub activity_capabilities: ActivityCapabilities,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProviderEvent {
    pub native_event_id: Option<String>,
    pub event_type: String,
    pub thread_id: String,
    pub turn_id: Option<String>,
    pub request_id: Option<String>,
    pub payload: Value,
    pub activity: Vec<ProviderActivityMutation>,
}
```

Update every current constructor explicitly with
`activity_capabilities: ActivityCapabilities::none()`, `native_event_id`, and
`activity: Vec::new()`. Do not make activity records from existing generic task
events.

Advertise `activityProtocolVersion: 1` in the existing server capability/config
payload only after the activity RPC registry and projection are installed.
Older clients ignore this additive field; this plan's client does not subscribe
when it is absent or has an unsupported value.

- [ ] **Step 4: Connect the supervisor to `ActivityProjection`**

Add the projection to supervisor construction and worker functions. After a
driver starts successfully:

```rust
let activity_scope = ActivityScopeSeed::thread(
    format!("thread:{}", request.thread_id),
    request.thread_id.clone(),
    request.provider.clone(),
    request.provider_instance_id.clone(),
    started.activity_capabilities.clone(),
);
let activity_enabled = match activity.ensure_scope(activity_scope).await {
    Ok(()) => true,
    Err(error) => {
        tracing::warn!(%error, "activity scope unavailable; continuing provider session");
        false
    }
};
```

Carry `activity_enabled` into the event pump and skip only activity projection
when false. Scope creation/persistence failure must not fail provider launch or
ordinary conversation projection.

In `spawn_event_pump`, apply non-empty mutation batches before moving the event
payload into the ordinary orchestration projection. Activity batches require a
stable native key; the adapter must derive a deterministic fallback from native
IDs when the provider omits an explicit event ID:

```rust
if !event.activity.is_empty() {
    if let Some(native_event_key) = event.native_event_id.clone() {
        if let Err(error) = activity.apply(
            &format!("thread:{}", launch.thread_id),
            native_event_key,
            event.activity.clone(),
            now(),
        ).await {
            tracing::warn!(%error, "failed to project provider activity batch");
        }
    } else {
        tracing::warn!(
            provider = %launch.provider,
            thread_id = %launch.thread_id,
            "dropped activity batch without a stable native event key"
        );
    }
}
```

Provider-event projection failures remain diagnostic and do not stop the normal
conversation stream. When the provider session exits unexpectedly, mark the
scope `stale`; reconciliation in later provider plans decides whether active
records can be recovered or become interrupted.

- [ ] **Step 5: Keep operational logging bounded**

Update `ProviderEventSummary` to log only mutation count and native event ID,
never the full activity entry detail:

```rust
activity_mutation_count: event.activity.len(),
native_event_id: event.native_event_id.as_deref(),
```

- [ ] **Step 6: Run provider supervisor and operational-log tests**

```bash
cargo test -p bibcode-server --test production_provider_runtime
cargo test -p bibcode-server production::operational_logs::tests
```

Expected: PASS.

- [ ] **Step 7: Commit provider plumbing**

```bash
git add apps/server/src/production/provider_runtime.rs \
  apps/server/src/production/runtime.rs apps/server/src/production/operational_logs.rs \
  apps/server/tests/production_provider_runtime.rs
git commit -m "feat(activity): project normalized provider activity"
```

---

## Task 5: Build the revision-aware client state and paged queries

**Files:**

- Create: `packages/client-runtime/src/state/activityReducer.ts`
- Create: `packages/client-runtime/src/state/activityReducer.test.ts`
- Create: `packages/client-runtime/src/state/activity.ts`
- Create: `packages/client-runtime/src/state/activity.test.ts`
- Modify: `packages/client-runtime/package.json`
- Create: `apps/web/src/state/activity.ts`

**Interfaces:**

```ts
export interface EnvironmentActivityState {
  readonly snapshot: Option.Option<ActivitySnapshot>;
  readonly status: "empty" | "synchronizing" | "live" | "stale";
  readonly error: Option.Option<string>;
  readonly recentEntries: ReadonlyMap<ActivityRecordId, ReadonlyArray<ActivityEntry>>;
}

export function applyActivityDelta(
  snapshot: ActivitySnapshot,
  delta: ActivityDelta,
): { readonly kind: "applied"; readonly snapshot: ActivitySnapshot } |
   { readonly kind: "duplicate" } |
   { readonly kind: "gap" };
```

- [ ] **Step 1: Write failing reducer tests**

Cover these exact cases in `activityReducer.test.ts`:

- matching revision upserts an actor and updates counts;
- a duplicate/older revision returns `duplicate` and preserves object identity;
- a future `previousRevision` returns `gap`;
- terminal actor state does not regress when a malformed delta reaches the client;
- removal updates the bounded summary list without changing exact server counts;
- a background-section health change leaves Subagents health and records unchanged;
- entry appends are retained only in `recentEntries`, capped at 200 per owner.

- [ ] **Step 2: Run reducer tests and verify the red state**

```bash
vp test run packages/client-runtime/src/state/activityReducer.test.ts
```

Expected: FAIL because the reducer does not exist.

- [ ] **Step 3: Implement the pure reducer**

Use `effect/Array` helpers and exhaustive `_tag`/`kind` switches. The revision
gate runs before changes:

```ts
if (delta.scopeId !== snapshot.scopeId) return { kind: "gap" };
if (delta.revision <= snapshot.revision) return { kind: "duplicate" };
if (delta.previousRevision !== snapshot.revision) return { kind: "gap" };
```

For each upsert, replace by ID or append, then sort active rows by `startedAt`
ascending and done rows by `terminalAt ?? updatedAt` descending. Never recompute
`counts`; take counts only from `scope-updated`.

- [ ] **Step 4: Write failing Effect Stream state tests**

In `activity.test.ts`, provide a fake `EnvironmentSupervisor`/RPC client and
assert:

- first snapshot makes state `live`;
- disconnect preserves the snapshot and makes it `stale`;
- reconnect subscribes again;
- a revision gap invokes `activity.getSnapshot` once and atomically replaces state;
- an expected stream failure sets a user-safe error and retries after 250 ms;
- roster/detail query families use the exact scope/record input as their cache key.

- [ ] **Step 5: Run the state test and verify the red state**

```bash
vp test run packages/client-runtime/src/state/activity.test.ts
```

Expected: FAIL because `createEnvironmentActivityAtoms` does not exist.

- [ ] **Step 6: Implement the durable activity state**

Follow `packages/client-runtime/src/state/threads.ts`:

- `SubscriptionRef<EnvironmentActivityState>` owns current state;
- `subscribe(WS_METHODS.subscribeActivity, scope, …)` follows connection replacement;
- connection projection phases map to synchronizing/stale/live without clearing data;
- on a gap, call `request(WS_METHODS.activityGetSnapshot, scope)` and replace atomically;
- no disk cache is added in v1; the server journal is authoritative;
- `Atom.setIdleTTL(30_000)` retains recently closed scopes without keeping subscriptions forever; and
- roster/detail use `createEnvironmentRpcQueryAtomFamily` with a 2-second stale time and 30-second idle TTL.

Export:

```ts
export function createEnvironmentActivityAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    stateAtom,
    stateValueAtom,
    roster: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:activity:roster",
      tag: WS_METHODS.activityListRoster,
      staleTimeMs: 2_000,
      idleTtlMs: 30_000,
    }),
    detail: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:activity:detail",
      tag: WS_METHODS.activityListDetail,
      staleTimeMs: 2_000,
      idleTtlMs: 30_000,
    }),
  };
}
```

Add an explicit `"./state/activity"` export in
`packages/client-runtime/package.json` if the package does not already use a
wildcard for state subpaths.

Bind it in `apps/web/src/state/activity.ts`:

```ts
import { createEnvironmentActivityAtoms } from "@bibcode/client-runtime/state/activity";
import { connectionAtomRuntime } from "../connection/runtime";

export const environmentActivity = createEnvironmentActivityAtoms(connectionAtomRuntime);
```

- [ ] **Step 7: Run client tests and typechecks**

```bash
vp test run packages/client-runtime/src/state/activityReducer.test.ts packages/client-runtime/src/state/activity.test.ts
vp run --filter @bibcode/client-runtime typecheck
vp run --filter @bibcode/web typecheck
```

Expected: PASS and clean typechecks.

- [ ] **Step 8: Commit the client activity state**

```bash
git add packages/client-runtime/src/state/activityReducer.ts \
  packages/client-runtime/src/state/activityReducer.test.ts \
  packages/client-runtime/src/state/activity.ts packages/client-runtime/src/state/activity.test.ts \
  packages/client-runtime/package.json apps/web/src/state/activity.ts
git commit -m "feat(activity): add durable client activity state"
```

---

## Plan 01 Verification

- [ ] Run all focused foundation suites:

```bash
vp test run packages/contracts/src/activity.test.ts packages/contracts/src/rpc.test.ts \
  packages/client-runtime/src/state/activityReducer.test.ts packages/client-runtime/src/state/activity.test.ts
cargo test -p bibcode-server --test activity_repository
cargo test -p bibcode-server --test activity_rpc
cargo test -p bibcode-server --test production_provider_runtime
cargo test -p bibcode-server --test rpc_wire
```

- [ ] Confirm the plan checkpoint:

  - synthetic actor/work-item mutations survive a server restart;
  - duplicate native events do not increment revision;
  - the stream begins with a snapshot and recovers from lag;
  - the client marks cached data stale during disconnect and replaces it after a gap; and
  - every real provider still reports no activity capability until its adapter plan lands.
