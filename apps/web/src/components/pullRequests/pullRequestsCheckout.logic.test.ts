import { describe, expect, it } from "vite-plus/test";
import { checkoutTargets, resultMessage, occupiedCheckout } from "./pullRequestsCheckout.logic";

describe("pull request checkout targets", () => {
  const worktrees = [
    { path: "/main", branch: "main", isBare: false, directoryState: "present" },
    { path: "/selected", branch: "topic", isBare: false, directoryState: "present" },
    { path: "/feature worktree", branch: "feature", isBare: false, directoryState: "present" },
  ] as const;
  it("leads with the selected checkout, then other paths, then a managed worktree", () => {
    expect(checkoutTargets(worktrees, "/selected")).toEqual([
      { kind: "checkout", cwd: "/selected", label: "Current checkout" },
      { kind: "checkout", cwd: "/main", label: "Another worktree…", branch: "main" },
      { kind: "checkout", cwd: "/feature worktree", label: "Another worktree…", branch: "feature" },
      { kind: "worktree", branchName: null, label: "New worktree…" },
    ]);
  });
  it("keeps current/new usable without inventory and preserves opaque remote paths", () => {
    expect(checkoutTargets([], "Z:\\repo")).toEqual([
      { kind: "checkout", cwd: "Z:\\repo", label: "Current checkout" },
      { kind: "worktree", branchName: null, label: "New worktree…" },
    ]);
  });
  it("omits bare/missing worktrees and duplicate paths", () => {
    const targets = checkoutTargets(
      [
        ...worktrees,
        worktrees[0],
        { path: "/bare", branch: null, isBare: true, directoryState: "present" },
        { path: "/missing", branch: "old", isBare: false, directoryState: "missing" },
      ],
      "/selected",
    );
    expect(targets).toHaveLength(4);
  });
  it.each([
    [{ kind: "checked_out", cwd: "/repo", branch: "feature" }, "Checked out feature in /repo"],
    [
      { kind: "worktree_created", cwd: "/new", branch: "feature", worktreeId: "id" },
      "Created worktree /new on feature",
    ],
    [
      {
        kind: "blocked",
        reason: {
          operation: "checkout",
          code: "dirty-working-tree",
          message: "Commit or stash your changes.",
        },
      },
      "Commit or stash your changes.",
    ],
  ] as const)("formats a $kind receipt verbatim", (result, message) =>
    expect(resultMessage(result)).toBe(message),
  );
  it("finds an occupied target from catalog data only for an occupancy refusal", () => {
    const result = {
      kind: "blocked",
      reason: {
        operation: "checkout",
        code: "worktree-checked-out",
        message: "Host message without a parseable path",
      },
    } as const;
    expect(occupiedCheckout(result, worktrees, "feature")).toBe("/feature worktree");
    expect(
      occupiedCheckout(
        { ...result, reason: { ...result.reason, code: "dirty-working-tree" } },
        worktrees,
        "feature",
      ),
    ).toBeNull();
    expect(occupiedCheckout(result, [], "feature")).toBeNull();
  });
});
