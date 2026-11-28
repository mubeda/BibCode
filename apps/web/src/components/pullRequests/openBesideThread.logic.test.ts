import { scopeThreadRef } from "@bibcode/client-runtime/environment";
import type { EnvironmentThreadShell } from "@bibcode/client-runtime/state/models";
import { describe, expect, it } from "vite-plus/test";

import {
  rankBesideThreadCandidates,
  selectHostThreadForProjectSurface,
} from "./openBesideThread.logic";

const thread = (
  id: string,
  branch: string | null,
  updatedAt: string,
  archivedAt: string | null = null,
  kind: "default" | "workspace" | "panel" = "workspace",
) =>
  ({
    id,
    environmentId: "env",
    title: `Thread ${id}`,
    branch,
    updatedAt,
    archivedAt,
    kind,
  }) as unknown as EnvironmentThreadShell;

describe("rankBesideThreadCandidates", () => {
  it("lists threads on the request's branch first, then the most recent, without archived or center-panel ones", () => {
    const ranked = rankBesideThreadCandidates(
      [
        thread("old", "main", "2026-10-01T00:00:00.000Z"),
        thread("branch-old", "feature/x", "2026-10-02T00:00:00.000Z"),
        thread("new", null, "2026-10-14T00:00:00.000Z"),
        thread("archived", "feature/x", "2026-10-15T00:00:00.000Z", "2026-10-15T01:00:00.000Z"),
        thread("branch-new", "feature/x", "2026-10-10T00:00:00.000Z"),
        thread("panel", "feature/x", "2026-10-15T00:00:00.000Z", null, "panel"),
      ],
      "feature/x",
    );
    expect(ranked.map((candidate) => [candidate.title, candidate.onBranch])).toEqual([
      ["Thread branch-new", true],
      ["Thread branch-old", true],
      ["Thread new", false],
      ["Thread old", false],
    ]);
    expect(ranked[0]!.ref).toEqual({ environmentId: "env", threadId: "branch-new" });
  });

  it("ranks purely by recency when headBranch is null or empty (branchless project routes)", () => {
    const ranked = rankBesideThreadCandidates(
      [
        thread("empty-branch", "", "2026-10-01T00:00:00.000Z"),
        thread("newer-main", "main", "2026-10-10T00:00:00.000Z"),
      ],
      null,
    );
    expect(ranked.map((candidate) => [candidate.ref.threadId, candidate.onBranch])).toEqual([
      ["newer-main", false],
      ["empty-branch", false],
    ]);
  });

  it("returns nothing for a project without live threads", () => {
    expect(rankBesideThreadCandidates([], "feature/x")).toEqual([]);
  });
});

describe("selectHostThreadForProjectSurface", () => {
  it("prefers the current eligible chat even when older than other threads", () => {
    const selected = selectHostThreadForProjectSurface({
      threads: [
        thread("current-older", "main", "2026-10-01T00:00:00.000Z"),
        thread("other-newer", "feature/pr", "2026-10-20T00:00:00.000Z"),
      ],
      currentThreadRef: scopeThreadRef("env" as never, "current-older" as never),
      preferredBranch: "feature/pr",
    });
    expect(selected).toEqual({ environmentId: "env", threadId: "current-older" });
  });

  it("ranks older-on-branch ahead of newer-off-branch when not on a project thread", () => {
    const selected = selectHostThreadForProjectSurface({
      threads: [
        thread("older-on-branch", "feature/pr", "2026-10-02T00:00:00.000Z"),
        thread("newer-off-branch", "main", "2026-10-20T00:00:00.000Z"),
      ],
      preferredBranch: "feature/pr",
    });
    expect(selected).toEqual({ environmentId: "env", threadId: "older-on-branch" });
  });

  it("skips archived and center-panel threads even when newest or current", () => {
    const selected = selectHostThreadForProjectSurface({
      threads: [
        thread("live", "main", "2026-10-01T00:00:00.000Z"),
        thread("newest-panel", "main", "2026-10-20T00:00:00.000Z", null, "panel"),
        thread("newest-archived", "main", "2026-10-25T00:00:00.000Z", "2026-10-25T01:00:00.000Z"),
      ],
      currentThreadRef: scopeThreadRef("env" as never, "newest-panel" as never),
      preferredBranch: null,
    });
    expect(selected).toEqual({ environmentId: "env", threadId: "live" });
  });

  it("returns null when zero eligible host threads exist", () => {
    const selected = selectHostThreadForProjectSurface({
      threads: [
        thread("only-panel", "main", "2026-10-20T00:00:00.000Z", null, "panel"),
        thread("only-archived", "main", "2026-10-25T00:00:00.000Z", "2026-10-25T01:00:00.000Z"),
      ],
      preferredBranch: null,
    });
    expect(selected).toBeNull();
  });
});
