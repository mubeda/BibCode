import {
  ActivityEntryId,
  ActivityRecordId,
  ActivityScopeId,
  ProviderDriverKind,
  ThreadId,
  type ActivityActorSummary,
  type ActivityDelta,
  type ActivityEntry,
  type ActivitySnapshot,
  type ActivityWorkItemSummary,
} from "@bibcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import {
  applyActivityDelta,
  applyEnvironmentActivityDelta,
  type EnvironmentActivityState,
} from "./activityReducer.ts";

const SCOPE_ID = ActivityScopeId.make("scope:thread-1");
const ACTOR_ID = ActivityRecordId.make("actor:child-1");
const WORK_ITEM_ID = ActivityRecordId.make("work:command-1");
const STARTED_AT = "2026-07-22T12:00:00Z";

function actor(overrides: Partial<ActivityActorSummary> = {}): ActivityActorSummary {
  return {
    _tag: "actor",
    id: ACTOR_ID,
    parentActorId: null,
    name: "Explore provider events",
    role: "explorer",
    providerType: "worker",
    status: "running",
    summary: "Reading protocol schemas",
    startedAt: STARTED_AT,
    updatedAt: "2026-07-22T12:00:01Z",
    terminalAt: null,
    ...overrides,
  };
}

function workItem(overrides: Partial<ActivityWorkItemSummary> = {}): ActivityWorkItemSummary {
  return {
    _tag: "workItem",
    id: WORK_ITEM_ID,
    ownerActorId: ACTOR_ID,
    name: "Run validation",
    workKind: "command",
    command: "vp check",
    cwd: "/repo",
    status: "running",
    summary: "Checking the workspace",
    startedAt: STARTED_AT,
    updatedAt: "2026-07-22T12:00:01Z",
    terminalAt: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<ActivitySnapshot> = {}): ActivitySnapshot {
  return {
    protocolVersion: 1,
    scopeId: SCOPE_ID,
    scope: { _tag: "thread", threadId: ThreadId.make("thread-1") },
    revision: 3,
    provider: ProviderDriverKind.make("codex"),
    providerInstanceId: null,
    capabilities: {
      actors: true,
      attributedActivity: true,
      backgroundWork: true,
      historyRecovery: "full",
      terminalObservation: false,
    },
    observationState: "live",
    sections: {
      subagents: { state: "live", message: null, retryable: false },
      backgroundTasks: { state: "live", message: null, retryable: false },
    },
    counts: {
      subagents: { active: 1, done: 0 },
      backgroundTasks: { active: 1, done: 0 },
    },
    actors: [actor()],
    workItems: [workItem()],
    actorsHasMore: false,
    workItemsHasMore: false,
    updatedAt: "2026-07-22T12:00:01Z",
    ...overrides,
  };
}

function delta(
  changes: ActivityDelta["changes"],
  overrides: Partial<ActivityDelta> = {},
): ActivityDelta {
  return {
    scopeId: SCOPE_ID,
    previousRevision: 3,
    revision: 4,
    changes,
    updatedAt: "2026-07-22T12:00:02Z",
    ...overrides,
  };
}

function environmentState(
  currentSnapshot: ActivitySnapshot = snapshot(),
): EnvironmentActivityState {
  return {
    snapshot: Option.some(currentSnapshot),
    status: "live",
    error: Option.none(),
    recentEntries: new Map(),
  };
}

function entry(index: number, ownerId: ActivityEntry["ownerId"] = ACTOR_ID): ActivityEntry {
  return {
    id: ActivityEntryId.make(`entry:${index}`),
    ownerKind: "actor",
    ownerId,
    kind: "commentary",
    title: `Update ${index}`,
    detail: null,
    tone: "info",
    createdAt: `2026-07-22T12:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}Z`,
  };
}

describe("applyActivityDelta", () => {
  it("applies a matching revision actor upsert and takes counts from scope-updated", () => {
    const laterActorId = ActivityRecordId.make("actor:later");
    const current = snapshot({
      actors: [
        actor({
          id: laterActorId,
          startedAt: "2026-07-22T08:10:00-04:00",
        }),
      ],
    });
    const nextCounts = {
      subagents: { active: 2, done: 0 },
      backgroundTasks: { active: 1, done: 0 },
    };

    const result = applyActivityDelta(
      current,
      delta([
        {
          kind: "scope-updated",
          capabilities: current.capabilities,
          observationState: current.observationState,
          sections: current.sections,
          counts: nextCounts,
        },
        { kind: "actor-upserted", actor: actor() },
      ]),
    );

    expect(result.kind).toBe("applied");
    if (result.kind === "applied") {
      expect(result.snapshot.revision).toBe(4);
      expect(result.snapshot.counts).toBe(nextCounts);
      expect(result.snapshot.actors.map((item) => item.id)).toEqual([laterActorId, ACTOR_ID]);
    }
  });

  it("returns duplicate for an older revision without mutating the snapshot", () => {
    const current = snapshot();
    const actors = current.actors;
    const result = applyActivityDelta(
      current,
      delta([{ kind: "actor-upserted", actor: actor({ name: "Replay" }) }], {
        previousRevision: 1,
        revision: 2,
      }),
    );

    expect(result).toEqual({ kind: "duplicate" });
    expect(current.actors).toBe(actors);
    expect(current.actors[0]?.name).toBe("Explore provider events");

    const state = environmentState(current);
    const stateResult = applyEnvironmentActivityDelta(
      state,
      delta([{ kind: "actor-upserted", actor: actor({ name: "Replay" }) }], {
        previousRevision: 2,
        revision: 3,
      }),
    );
    expect(stateResult.kind).toBe("duplicate");
    expect(stateResult.state).toBe(state);
  });

  it("returns gap for a future previous revision or a different scope", () => {
    expect(
      applyActivityDelta(
        snapshot(),
        delta([{ kind: "actor-upserted", actor: actor() }], {
          previousRevision: 5,
          revision: 6,
        }),
      ),
    ).toEqual({ kind: "gap" });

    expect(
      applyActivityDelta(
        snapshot(),
        delta([{ kind: "actor-upserted", actor: actor() }], {
          scopeId: ActivityScopeId.make("scope:other"),
        }),
      ),
    ).toEqual({ kind: "gap" });
  });

  it("does not regress a terminal actor when a malformed later delta arrives", () => {
    const completed = actor({
      status: "completed",
      summary: "Finished",
      updatedAt: "2026-07-22T12:05:00Z",
      terminalAt: "2026-07-22T12:05:00Z",
    });
    const current = snapshot({ actors: [completed] });

    const result = applyActivityDelta(
      current,
      delta([
        {
          kind: "actor-upserted",
          actor: actor({
            status: "running",
            summary: "Late progress",
            name: "Regressed name",
            role: "regressed-role",
            updatedAt: "2026-07-22T12:06:00Z",
            terminalAt: null,
          }),
        },
      ]),
    );

    expect(result.kind).toBe("applied");
    if (result.kind === "applied") {
      expect(result.snapshot.actors[0]).toBe(completed);
    }
  });

  it("ignores offset-aware actor updates older than the current row", () => {
    const currentActor = actor({
      name: "Current",
      updatedAt: "2026-07-22T08:00:00-04:00",
    });
    const current = snapshot({ actors: [currentActor] });

    const result = applyActivityDelta(
      current,
      delta([
        {
          kind: "actor-upserted",
          actor: actor({
            name: "Older",
            summary: "Must not replace current state",
            updatedAt: "2026-07-22T11:59:59Z",
          }),
        },
      ]),
    );

    expect(result.kind).toBe("applied");
    if (result.kind === "applied") {
      expect(result.snapshot.actors[0]).toBe(currentActor);
    }
  });

  it("rejects row upserts with backwards or inconsistent chronology", () => {
    const backwardsId = ActivityRecordId.make("actor:backwards");
    const invalidTerminalId = ActivityRecordId.make("actor:invalid-terminal");
    const current = snapshot();

    const result = applyActivityDelta(
      current,
      delta([
        {
          kind: "actor-upserted",
          actor: actor({
            id: backwardsId,
            startedAt: "2026-07-22T12:10:00Z",
            updatedAt: "2026-07-22T12:09:59Z",
          }),
        },
        {
          kind: "actor-upserted",
          actor: actor({
            id: invalidTerminalId,
            status: "completed",
            startedAt: "2026-07-22T12:00:00Z",
            updatedAt: "2026-07-22T12:05:00Z",
            terminalAt: "2026-07-22T12:06:00Z",
          }),
        },
      ]),
    );

    expect(result.kind).toBe("applied");
    if (result.kind === "applied") {
      expect(result.snapshot.actors).toBe(current.actors);
    }
  });

  it("does not reconcile a capped actor page for a stale terminal upsert that reduction rejects", () => {
    const currentActor = actor({ updatedAt: "2026-07-22T12:05:00Z" });
    const current = snapshot({ actors: [currentActor], actorsHasMore: true });

    const result = applyActivityDelta(
      current,
      delta([
        {
          kind: "actor-upserted",
          actor: actor({
            status: "completed",
            updatedAt: "2026-07-22T12:04:59Z",
            terminalAt: "2026-07-22T12:04:59Z",
          }),
        },
      ]),
    );

    expect(result.kind).toBe("applied");
    if (result.kind === "applied") {
      expect(result.snapshot.actors[0]).toBe(currentActor);
    }
  });

  it("does not reconcile a capped actor page for a malformed terminal upsert that reduction rejects", () => {
    const currentActor = actor();
    const current = snapshot({ actors: [currentActor], actorsHasMore: true });

    const result = applyActivityDelta(
      current,
      delta([
        {
          kind: "actor-upserted",
          actor: actor({
            status: "completed",
            updatedAt: "2026-07-22T12:05:00Z",
            terminalAt: "2026-07-22T12:05:01Z",
          }),
        },
      ]),
    );

    expect(result.kind).toBe("applied");
    if (result.kind === "applied") {
      expect(result.snapshot.actors[0]).toBe(currentActor);
    }
  });

  it("does not reconcile a capped work-item page for a stale terminal upsert that reduction rejects", () => {
    const currentWorkItem = workItem({ updatedAt: "2026-07-22T12:05:00Z" });
    const current = snapshot({ workItems: [currentWorkItem], workItemsHasMore: true });

    const result = applyActivityDelta(
      current,
      delta([
        {
          kind: "work-item-upserted",
          workItem: workItem({
            status: "completed",
            updatedAt: "2026-07-22T12:04:59Z",
            terminalAt: "2026-07-22T12:04:59Z",
          }),
        },
      ]),
    );

    expect(result.kind).toBe("applied");
    if (result.kind === "applied") {
      expect(result.snapshot.workItems[0]).toBe(currentWorkItem);
    }
  });

  it("does not reconcile a capped work-item page for a malformed terminal upsert that reduction rejects", () => {
    const currentWorkItem = workItem();
    const current = snapshot({ workItems: [currentWorkItem], workItemsHasMore: true });

    const result = applyActivityDelta(
      current,
      delta([
        {
          kind: "work-item-upserted",
          workItem: workItem({
            status: "completed",
            updatedAt: "2026-07-22T12:05:00Z",
            terminalAt: "2026-07-22T12:05:01Z",
          }),
        },
      ]),
    );

    expect(result.kind).toBe("applied");
    if (result.kind === "applied") {
      expect(result.snapshot.workItems[0]).toBe(currentWorkItem);
    }
  });

  it("removes a bounded summary without changing exact server counts", () => {
    const current = snapshot();

    const result = applyActivityDelta(
      current,
      delta([{ kind: "actor-removed", actorId: ACTOR_ID }]),
    );

    expect(result.kind).toBe("applied");
    if (result.kind === "applied") {
      expect(result.snapshot.actors).toEqual([]);
      expect(result.snapshot.counts).toBe(current.counts);
    }
  });

  it("isolates background-section health updates from Subagents health and records", () => {
    const current = snapshot();
    const subagents = current.sections.subagents;
    const actors = current.actors;
    const workItems = current.workItems;

    const result = applyActivityDelta(
      current,
      delta([
        {
          kind: "scope-updated",
          capabilities: current.capabilities,
          observationState: "stale",
          sections: {
            subagents: { ...subagents },
            backgroundTasks: {
              state: "error",
              message: "Metrics unavailable",
              retryable: true,
            },
          },
          counts: current.counts,
        },
      ]),
    );

    expect(result.kind).toBe("applied");
    if (result.kind === "applied") {
      expect(result.snapshot.sections.subagents).toBe(subagents);
      expect(result.snapshot.actors).toBe(actors);
      expect(result.snapshot.workItems).toBe(workItems);
      expect(result.snapshot.sections.backgroundTasks.state).toBe("error");
    }
  });

  it("keeps entry appends only in immutable per-owner recent buffers capped at 200", () => {
    const originalEntry = entry(0);
    const originalEntries = [originalEntry] as const;
    const originalMap = new Map([[ACTOR_ID, originalEntries]]);
    const state: EnvironmentActivityState = {
      ...environmentState(),
      recentEntries: originalMap,
    };
    const appended = Array.from({ length: 205 }, (_, index) => ({
      kind: "entry-appended" as const,
      entry: entry(index + 1),
    }));

    const result = applyEnvironmentActivityDelta(state, delta(appended));

    expect(result.kind).toBe("applied");
    expect(result.state.recentEntries).not.toBe(originalMap);
    expect(result.state.recentEntries.get(ACTOR_ID)).not.toBe(originalEntries);
    expect(originalMap.get(ACTOR_ID)).toEqual([originalEntry]);
    expect(result.state.recentEntries.get(ACTOR_ID)).toHaveLength(200);
    expect(result.state.recentEntries.get(ACTOR_ID)?.[0]?.id).toBe(ActivityEntryId.make("entry:6"));
    expect(result.state.recentEntries.get(ACTOR_ID)?.at(-1)?.id).toBe(
      ActivityEntryId.make("entry:205"),
    );
    expect(Option.getOrThrow(result.state.snapshot).actors).toBe(
      Option.getOrThrow(state.snapshot).actors,
    );
  });

  it("removes actor and work-item entry owners without mutating unrelated buffers", () => {
    const unrelatedOwnerId = ActivityRecordId.make("actor:unrelated");
    const actorEntries = [entry(1)] as const;
    const workEntries = [entry(2, WORK_ITEM_ID)] as const;
    const unrelatedEntries = [entry(3, unrelatedOwnerId)] as const;
    const originalMap = new Map([
      [ACTOR_ID, actorEntries],
      [WORK_ITEM_ID, workEntries],
      [unrelatedOwnerId, unrelatedEntries],
    ]);
    const state: EnvironmentActivityState = {
      ...environmentState(),
      recentEntries: originalMap,
    };

    const result = applyEnvironmentActivityDelta(
      state,
      delta([
        { kind: "actor-removed", actorId: ACTOR_ID },
        { kind: "work-item-removed", workItemId: WORK_ITEM_ID },
      ]),
    );

    expect(result.kind).toBe("applied");
    expect(result.state.recentEntries).not.toBe(originalMap);
    expect(result.state.recentEntries.has(ACTOR_ID)).toBe(false);
    expect(result.state.recentEntries.has(WORK_ITEM_ID)).toBe(false);
    expect(result.state.recentEntries.get(unrelatedOwnerId)).toBe(unrelatedEntries);
    expect(originalMap.get(ACTOR_ID)).toBe(actorEntries);
    expect(originalMap.get(WORK_ITEM_ID)).toBe(workEntries);
  });

  it("invalidates a retained owner buffer when the server replaces its entries", () => {
    const unrelatedOwnerId = ActivityRecordId.make("actor:unrelated");
    const ownerEntries = [entry(1)] as const;
    const unrelatedEntries = [entry(2, unrelatedOwnerId)] as const;
    const state: EnvironmentActivityState = {
      ...environmentState(),
      recentEntries: new Map([
        [ACTOR_ID, ownerEntries],
        [unrelatedOwnerId, unrelatedEntries],
      ]),
    };

    const result = applyEnvironmentActivityDelta(
      state,
      delta([
        {
          kind: "entries-replaced",
          ownerKind: "actor",
          ownerId: ACTOR_ID,
        },
      ] as unknown as ActivityDelta["changes"]),
    );

    expect(result.kind).toBe("applied");
    expect(result.state.recentEntries.has(ACTOR_ID)).toBe(false);
    expect(result.state.recentEntries.get(unrelatedOwnerId)).toBe(unrelatedEntries);
  });

  it("caps recent-entry owner keys at the 200 most recent deterministic owners", () => {
    const changes = Array.from({ length: 202 }, (_, index) => {
      const ownerId = ActivityRecordId.make(`actor:owner-${String(index).padStart(3, "0")}`);
      return {
        kind: "entry-appended" as const,
        entry: {
          ...entry(index, ownerId),
          createdAt: index === 201 ? "2026-07-22T12:00:01Z" : "2026-07-22T12:00:00Z",
        },
      };
    });

    const result = applyEnvironmentActivityDelta(environmentState(), delta(changes));

    expect(result.kind).toBe("applied");
    expect(result.state.recentEntries.size).toBe(200);
    expect(result.state.recentEntries.has(ActivityRecordId.make("actor:owner-000"))).toBe(true);
    expect(result.state.recentEntries.has(ActivityRecordId.make("actor:owner-198"))).toBe(true);
    expect(result.state.recentEntries.has(ActivityRecordId.make("actor:owner-199"))).toBe(false);
    expect(result.state.recentEntries.has(ActivityRecordId.make("actor:owner-200"))).toBe(false);
    expect(result.state.recentEntries.has(ActivityRecordId.make("actor:owner-201"))).toBe(true);
  });
});
