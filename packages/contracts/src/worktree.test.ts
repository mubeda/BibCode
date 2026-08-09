import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  VcsAdoptedWorktreeStatus,
  VcsWorktreeCatalogSnapshot,
  VcsWorktreeDescriptor,
  WorktreeAdoptionError,
  WorktreeCatalogError,
  WorktreeRemovalError,
  WorktreeRemovalPlan,
  WorktreeRemovalResult,
  WorkspaceUnavailableError,
} from "./worktree.ts";

const decodeDescriptor = Schema.decodeUnknownSync(VcsWorktreeDescriptor);
const encodeDescriptor = Schema.encodeSync(VcsWorktreeDescriptor);
const decodeSnapshot = Schema.decodeUnknownSync(VcsWorktreeCatalogSnapshot);
const encodeSnapshot = Schema.encodeSync(VcsWorktreeCatalogSnapshot);
const decodeAdoptedWorkspace = Schema.decodeUnknownSync(VcsAdoptedWorktreeStatus);
const encodeAdoptedWorkspace = Schema.encodeSync(VcsAdoptedWorktreeStatus);
const decodeRemovalPlan = Schema.decodeUnknownSync(WorktreeRemovalPlan);
const decodeRemovalResult = Schema.decodeUnknownSync(WorktreeRemovalResult);
const encodeRemovalResult = Schema.encodeSync(WorktreeRemovalResult);
const decodeCatalogError = Schema.decodeUnknownSync(WorktreeCatalogError);
const encodeCatalogError = Schema.encodeSync(WorktreeCatalogError);
const decodeAdoptionError = Schema.decodeUnknownSync(WorktreeAdoptionError);
const encodeAdoptionError = Schema.encodeSync(WorktreeAdoptionError);
const decodeRemovalError = Schema.decodeUnknownSync(WorktreeRemovalError);
const encodeRemovalError = Schema.encodeSync(WorktreeRemovalError);
const decodeWorkspaceUnavailableError = Schema.decodeUnknownSync(WorkspaceUnavailableError);
const encodeWorkspaceUnavailableError = Schema.encodeSync(WorkspaceUnavailableError);

const baseDescriptor = {
  worktreeKey: "worktree-primary",
  path: "/repo",
  branch: "main",
  head: "abc123",
  isPrimary: true,
  isBare: false,
  locked: false,
  registrationState: "registered",
  directoryState: "present",
  adoptionState: "none",
  eligibleForAdoption: false,
} as const;

describe("worktree catalog schemas", () => {
  it("round-trips every descriptor state and a degraded retained snapshot", () => {
    const descriptors = [
      baseDescriptor,
      {
        ...baseDescriptor,
        worktreeKey: "worktree-prunable",
        path: "/repo/missing",
        branch: null,
        head: null,
        isPrimary: false,
        isBare: true,
        locked: true,
        lockReason: "maintenance",
        registrationState: "prunable",
        directoryState: "missing",
        adoptionState: "active",
        adoptedThreadId: "thread-active",
        eligibleForAdoption: false,
      },
      {
        ...baseDescriptor,
        worktreeKey: "worktree-unknown",
        path: "/repo/feature",
        isPrimary: false,
        registrationState: "registered",
        directoryState: "unknown",
        adoptionState: "archived",
        adoptedThreadId: "thread-archived",
        eligibleForAdoption: true,
      },
    ] as const;
    const snapshot = {
      repositoryKey: "repository-1",
      generation: 3,
      authoritative: false,
      observedAt: "2026-08-09T00:00:00.000Z",
      scanStatus: {
        _tag: "degraded",
        reason: "git-failed",
        message: "git worktree list failed",
        failedAt: "2026-08-09T00:00:00.000Z",
        lastAuthoritativeAt: "2026-08-08T00:00:00.000Z",
      },
      worktrees: descriptors,
      adoptedWorkspaces: [],
    } as const;

    const decodedDescriptors = descriptors.map((descriptor) => decodeDescriptor(descriptor));
    const decodedSnapshot = decodeSnapshot(snapshot);

    expect(
      decodedDescriptors.map((descriptor) => decodeDescriptor(encodeDescriptor(descriptor))),
    ).toEqual(descriptors);
    expect(decodeSnapshot(encodeSnapshot(decodedSnapshot))).toEqual(snapshot);
  });

  it("round-trips active and archived server-supplied adopted workspace joins", () => {
    const joins = [
      {
        threadId: "thread-active",
        worktreeKey: "worktree-active",
        path: "/repo/active",
        branch: "feature/active",
        availability: "present",
        registrationState: "registered",
        locked: false,
      },
      {
        threadId: "thread-archived",
        worktreeKey: null,
        path: "/repo/archived",
        branch: null,
        availability: "missing-unregistered",
        registrationState: null,
        locked: true,
        lockReason: "retain for recovery",
      },
    ] as const;

    const decodedJoins = joins.map((join) => decodeAdoptedWorkspace(join));

    expect(
      decodedJoins.map((join) => decodeAdoptedWorkspace(encodeAdoptedWorkspace(join))),
    ).toEqual(joins);
  });

  it("rejects catalog and removal-plan arrays above their fixed bound", () => {
    expect(() =>
      decodeSnapshot({
        repositoryKey: "repository-1",
        generation: 1,
        authoritative: true,
        observedAt: "2026-08-09T00:00:00.000Z",
        scanStatus: { _tag: "ready" },
        worktrees: Array.from({ length: 513 }, () => baseDescriptor),
        adoptedWorkspaces: [],
      }),
    ).toThrow();
    expect(() =>
      decodeRemovalPlan({
        planToken: "plan-1",
        generation: 1,
        availability: "present",
        registered: true,
        locked: false,
        trackedChangeCount: 0,
        untrackedFileCount: 0,
        pruneImpact: Array.from({ length: 513 }, () => ({ path: "/repo/missing", locked: false })),
      }),
    ).toThrow();
  });

  it("keeps nullable descriptor and availability fields distinct from omitted lock reasons", () => {
    const descriptor = decodeDescriptor({
      ...baseDescriptor,
      branch: null,
      head: null,
    });
    const adopted = decodeAdoptedWorkspace({
      threadId: "thread-1",
      worktreeKey: null,
      path: "/repo/missing",
      branch: null,
      availability: "missing-unregistered",
      registrationState: null,
      locked: false,
    });

    expect(descriptor.branch).toBeNull();
    expect(descriptor.head).toBeNull();
    expect(descriptor.lockReason).toBeUndefined();
    expect(adopted.worktreeKey).toBeNull();
    expect(adopted.branch).toBeNull();
    expect(adopted.registrationState).toBeNull();
    expect(adopted.lockReason).toBeUndefined();
  });

  it("round-trips every tagged error and removal result", () => {
    const catalogError = decodeCatalogError({
      _tag: "WorktreeCatalogError",
      reason: "repository-unavailable",
      message: "No repository.",
    });
    const adoptionError = decodeAdoptionError({
      _tag: "WorktreeAdoptionError",
      reason: "stale-generation",
      message: "Refresh before adopting.",
      currentGeneration: 2,
    });
    const removalError = decodeRemovalError({
      _tag: "WorktreeRemovalError",
      reason: "stale-plan",
      message: "Request a new plan.",
      currentGeneration: 3,
    });
    const workspaceUnavailableError = decodeWorkspaceUnavailableError({
      _tag: "WorkspaceUnavailableError",
      reason: "workspace-unavailable",
      message: "The checkout is missing.",
      threadId: "thread-1",
      path: "/repo/missing",
      availability: "missing-registered",
    });
    const results = [
      {
        threadRemoved: true,
        gitOutcome: "not-requested",
        orphanCleanupPending: false,
      },
      {
        threadRemoved: true,
        gitOutcome: "failed",
        detail: "Git cleanup could not be verified.",
        orphanCleanupPending: true,
      },
    ] as const;

    expect(decodeCatalogError(encodeCatalogError(catalogError))._tag).toBe("WorktreeCatalogError");
    expect(decodeAdoptionError(encodeAdoptionError(adoptionError))._tag).toBe(
      "WorktreeAdoptionError",
    );
    expect(decodeRemovalError(encodeRemovalError(removalError))._tag).toBe("WorktreeRemovalError");
    expect(
      decodeWorkspaceUnavailableError(encodeWorkspaceUnavailableError(workspaceUnavailableError))
        ._tag,
    ).toBe("WorkspaceUnavailableError");
    expect(
      results.map((result) =>
        decodeRemovalResult(encodeRemovalResult(decodeRemovalResult(result))),
      ),
    ).toEqual(results);
  });
});
