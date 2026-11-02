import { describe, expect, it } from "vite-plus/test";

import { ProjectId, ProviderInstanceId, ThreadId } from "@bibcode/contracts";
import type { OrchestrationShellSnapshot, OrchestrationShellStreamEvent } from "@bibcode/contracts";

import { applyShellStreamEvent } from "./shellReducer.ts";

const baseSnapshot: OrchestrationShellSnapshot = {
  snapshotSequence: 0,
  projects: [],
  threads: [],
  updatedAt: "2026-04-01T00:00:00.000Z",
};

const stubProject = {
  id: ProjectId.make("project-1"),
  title: "Test Project",
  workspaceRoot: "/workspace/test",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  worktreeDiscovery: {
    visibility: "hidden",
    initialPromptDismissedAt: null,
    baselinePaths: [],
  },
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
} as const;

const stubThread = {
  id: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  title: "Test Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  archivedAt: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  session: null,
} as const;

describe("applyShellStreamEvent", () => {
  it("ignores stale project upserts without mutating the snapshot", () => {
    const snapshotWithProject: OrchestrationShellSnapshot = {
      ...baseSnapshot,
      snapshotSequence: 4,
      projects: [stubProject],
    };

    for (const sequence of [3, 4]) {
      const next = applyShellStreamEvent(snapshotWithProject, {
        kind: "project-upserted",
        sequence,
        project: { ...stubProject, title: "Stale Title" },
      });

      expect(next).toBe(snapshotWithProject);
      expect(next.snapshotSequence).toBe(4);
      expect(next.projects[0]?.title).toBe("Test Project");
    }
  });

  describe("project-upserted", () => {
    it("adds a new project", () => {
      const event: OrchestrationShellStreamEvent = {
        kind: "project-upserted",
        sequence: 1,
        project: stubProject,
      };

      const next = applyShellStreamEvent(baseSnapshot, event);

      expect(next.projects).toHaveLength(1);
      expect(next.projects[0]?.id).toBe("project-1");
      expect(next.snapshotSequence).toBe(1);
    });

    it("updates an existing project", () => {
      const snapshotWithProject: OrchestrationShellSnapshot = {
        ...baseSnapshot,
        projects: [stubProject],
      };

      const updatedProject = {
        ...stubProject,
        title: "Updated Title",
        worktreeDiscovery: {
          visibility: "shown" as const,
          initialPromptDismissedAt: "2026-08-09T00:00:00.000Z",
          baselinePaths: ["/workspace/test-worktree"],
        },
      };
      const event: OrchestrationShellStreamEvent = {
        kind: "project-upserted",
        sequence: 2,
        project: updatedProject,
      };

      const next = applyShellStreamEvent(snapshotWithProject, event);

      expect(next.projects).toHaveLength(1);
      expect(next.projects[0]?.title).toBe("Updated Title");
      expect(next.projects[0]?.worktreeDiscovery).toEqual(updatedProject.worktreeDiscovery);
      expect(next.snapshotSequence).toBe(2);
    });
  });

  describe("project-removed", () => {
    it("removes a project by id", () => {
      const snapshotWithProject: OrchestrationShellSnapshot = {
        ...baseSnapshot,
        projects: [stubProject],
      };

      const event: OrchestrationShellStreamEvent = {
        kind: "project-removed",
        sequence: 3,
        projectId: ProjectId.make("project-1"),
      };

      const next = applyShellStreamEvent(snapshotWithProject, event);

      expect(next.projects).toHaveLength(0);
      expect(next.snapshotSequence).toBe(3);
    });
  });

  describe("thread-upserted", () => {
    it("adds a new thread", () => {
      const event: OrchestrationShellStreamEvent = {
        kind: "thread-upserted",
        sequence: 4,
        thread: stubThread,
      };

      const next = applyShellStreamEvent(baseSnapshot, event);

      expect(next.threads).toHaveLength(1);
      expect(next.threads[0]?.id).toBe("thread-1");
      expect(next.snapshotSequence).toBe(4);
    });

    it("updates an existing thread", () => {
      const snapshotWithThread: OrchestrationShellSnapshot = {
        ...baseSnapshot,
        threads: [stubThread],
      };

      const updatedThread = { ...stubThread, title: "Updated Thread" };
      const event: OrchestrationShellStreamEvent = {
        kind: "thread-upserted",
        sequence: 5,
        thread: updatedThread,
      };

      const next = applyShellStreamEvent(snapshotWithThread, event);

      expect(next.threads).toHaveLength(1);
      expect(next.threads[0]?.title).toBe("Updated Thread");
    });
  });

  describe("thread-removed", () => {
    it("removes a thread by id", () => {
      const snapshotWithThread: OrchestrationShellSnapshot = {
        ...baseSnapshot,
        threads: [stubThread],
      };

      const event: OrchestrationShellStreamEvent = {
        kind: "thread-removed",
        sequence: 6,
        threadId: ThreadId.make("thread-1"),
      };

      const next = applyShellStreamEvent(snapshotWithThread, event);

      expect(next.threads).toHaveLength(0);
      expect(next.snapshotSequence).toBe(6);
    });
  });

  it("applies a server delta chunk once, keeping untouched threads and the upsert's activity age", () => {
    const untouched = { ...stubThread, id: ThreadId.make("thread-2"), title: "Untouched" };
    const removed = { ...stubThread, id: ThreadId.make("thread-3") };
    const snapshot: OrchestrationShellSnapshot = {
      ...baseSnapshot,
      snapshotSequence: 10,
      projects: [stubProject],
      threads: [stubThread, untouched, removed],
    };
    // One coalesced tick as the server numbers it: consecutive sequences ending at its own.
    const chunk: ReadonlyArray<OrchestrationShellStreamEvent> = [
      { kind: "project-upserted", sequence: 12, project: { ...stubProject, title: "Renamed" } },
      {
        kind: "thread-upserted",
        sequence: 13,
        thread: {
          ...stubThread,
          title: "Streaming",
          lastActivityAt: "2026-04-01T00:00:05.000Z",
          lastActivityAgeMs: 1_200,
        },
      },
      { kind: "thread-removed", sequence: 14, threadId: removed.id },
    ];

    const next = chunk.reduce(applyShellStreamEvent, snapshot);

    expect(next.snapshotSequence).toBe(14);
    expect(next.projects.map((project) => project.title)).toEqual(["Renamed"]);
    expect(next.threads.map((thread) => thread.id)).toEqual(["thread-1", "thread-2"]);
    expect(next.threads[0]).toMatchObject({ title: "Streaming", lastActivityAgeMs: 1_200 });
    expect(next.threads[1]).toBe(untouched);
    // A duplicate delivery of the same chunk is stale and changes nothing.
    expect(chunk.reduce(applyShellStreamEvent, next)).toBe(next);
  });

  it("returns original snapshot for unrecognized event kinds", () => {
    const unknownEvent = { kind: "unknown-future-event", sequence: 99 } as any;
    const next = applyShellStreamEvent(baseSnapshot, unknownEvent);
    expect(next).toBe(baseSnapshot);
  });
});
