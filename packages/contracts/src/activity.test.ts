import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import * as ActivityModule from "./activity.ts";
import * as ContractsPackage from "./index.ts";
import {
  ActivityDelta,
  ActivityDetailPage,
  ActivityError,
  ActivityListDetailInput,
  ActivityListRosterInput,
  ActivityScopeRef,
  ActivitySnapshot,
  ActivityStreamItem,
} from "./activity.ts";

const decodeActivityDelta = Schema.decodeUnknownSync(ActivityDelta);
const decodeActivityError = Schema.decodeUnknownSync(ActivityError);
const decodeActivityDetailPage = Schema.decodeUnknownSync(ActivityDetailPage);
const decodeActivityListDetailInput = Schema.decodeUnknownSync(ActivityListDetailInput);
const decodeActivityListRosterInput = Schema.decodeUnknownSync(ActivityListRosterInput);
const decodeActivityScopeRef = Schema.decodeUnknownSync(ActivityScopeRef);
const decodeActivitySnapshot = Schema.decodeUnknownSync(ActivitySnapshot);
const decodeActivityStreamItem = Schema.decodeUnknownSync(ActivityStreamItem);

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
const delta = {
  scopeId: snapshot.scopeId,
  previousRevision: 3,
  revision: 4,
  changes: [{ kind: "actor-upserted" as const, actor }],
  updatedAt: "2026-07-22T12:00:02Z",
};

describe("activity contracts", () => {
  it("decodes feature-disabled activity failures", () => {
    // Mutation caught: omitting featureDisabled from the ActivityError wire reason union.
    expect(
      decodeActivityError({
        _tag: "ActivityError",
        reason: "featureDisabled",
        message: "Agent activity is disabled for this environment.",
      }).reason,
    ).toBe("featureDisabled");
  });

  it("keeps activity timestamp bounds private", () => {
    expect(ActivityModule).not.toHaveProperty("ACTIVITY_TIMESTAMP_MAX_LENGTH");
    expect(ContractsPackage).not.toHaveProperty("ACTIVITY_TIMESTAMP_MAX_LENGTH");
  });

  it("round-trips a thread scope snapshot and stream item", () => {
    expect(decodeActivityScopeRef(snapshot.scope)).toEqual(snapshot.scope);
    expect(decodeActivitySnapshot(snapshot)).toEqual(snapshot);
    expect(decodeActivityStreamItem({ kind: "snapshot", snapshot })).toEqual({
      kind: "snapshot",
      snapshot,
    });
  });

  it("round-trips an ordered actor delta", () => {
    expect(decodeActivityDelta(delta)).toEqual(delta);
  });

  it("rejects invalid snapshot revisions", () => {
    expect(() =>
      decodeActivitySnapshot({
        ...snapshot,
        revision: -1,
      }),
    ).toThrow();
  });

  it("rejects oversized actor labels", () => {
    expect(() =>
      decodeActivitySnapshot({
        ...snapshot,
        actors: [{ ...actor, name: "x".repeat(257) }],
      }),
    ).toThrow();
  });

  it("rejects oversized detail entry pages", () => {
    expect(() =>
      decodeActivityDetailPage({
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
        nextCursor: null,
      }),
    ).toThrow();
  });

  it("rejects oversized detail cursors", () => {
    expect(() =>
      decodeActivityDetailPage({
        record: actor,
        entries: [],
        nextCursor: "x".repeat(513),
      }),
    ).toThrow();
  });

  it("rejects empty delta batches", () => {
    expect(() => decodeActivityDelta({ ...delta, changes: [] })).toThrow();
  });

  it("rejects oversized delta batches", () => {
    expect(() =>
      decodeActivityDelta({
        ...delta,
        changes: Array.from({ length: 257 }, () => delta.changes[0]),
      }),
    ).toThrow();
  });

  it("rejects roster page limits outside 1 through 200", () => {
    const input = {
      scope: snapshot.scope,
      scopeId: snapshot.scopeId,
      section: "subagents",
      bucket: "active",
    } as const;

    expect(() => decodeActivityListRosterInput({ ...input, limit: 0 })).toThrow();
    expect(() => decodeActivityListRosterInput({ ...input, limit: 201 })).toThrow();
  });

  it("rejects detail page limits outside 1 through 200", () => {
    const input = {
      scope: snapshot.scope,
      scopeId: snapshot.scopeId,
      recordKind: "actor",
      recordId: actor.id,
    } as const;

    expect(() => decodeActivityListDetailInput({ ...input, limit: 0 })).toThrow();
    expect(() => decodeActivityListDetailInput({ ...input, limit: 201 })).toThrow();
  });

  it("requires an authoritative root descriptor for every activity paging request", () => {
    expect(() =>
      decodeActivityListRosterInput({
        scopeId: snapshot.scopeId,
        section: "subagents",
        bucket: "active",
      }),
    ).toThrow();
    expect(() =>
      decodeActivityListDetailInput({
        scopeId: snapshot.scopeId,
        recordKind: "actor",
        recordId: actor.id,
      }),
    ).toThrow();
  });

  it("rejects oversized thread IDs", () => {
    expect(() =>
      decodeActivityScopeRef({
        _tag: "thread",
        threadId: "x".repeat(257),
      }),
    ).toThrow();
  });

  it("rejects oversized timestamps", () => {
    expect(() =>
      decodeActivitySnapshot({
        ...snapshot,
        updatedAt: `2026-07-22T12:00:00.${"1".repeat(44)}Z`,
      }),
    ).toThrow();
  });

  it("rejects malformed timestamps", () => {
    expect(() =>
      decodeActivitySnapshot({
        ...snapshot,
        updatedAt: "not-a-timestamp",
      }),
    ).toThrow();
  });

  it("rejects parseable non-ISO timestamps", () => {
    expect(() =>
      decodeActivitySnapshot({
        ...snapshot,
        updatedAt: "July 22, 2026 12:00:00",
      }),
    ).toThrow();
  });

  it("rejects ISO-shaped timestamps with invalid calendar dates", () => {
    expect(() =>
      decodeActivitySnapshot({
        ...snapshot,
        updatedAt: "2026-02-30T12:00:00Z",
      }),
    ).toThrow();
  });
});
