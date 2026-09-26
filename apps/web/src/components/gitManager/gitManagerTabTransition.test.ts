import { describe, expect, it } from "vite-plus/test";

import {
  resolveGitManagerTabTransition,
  resolveGitManagerWorkingTree,
  type GitManagerTabTransitionInputs,
  type GitManagerWorkingTree,
} from "./gitManagerTabTransition";

const inputs = (
  workingTree: GitManagerWorkingTree,
  mergePending = false,
): GitManagerTabTransitionInputs => ({ mergePending, workingTree });

describe("resolveGitManagerWorkingTree", () => {
  it("reads loading, dirty and clean from the status", () => {
    expect(resolveGitManagerWorkingTree(null)).toBe("loading");
    expect(resolveGitManagerWorkingTree({ isRepo: true, hasWorkingTreeChanges: true })).toBe(
      "dirty",
    );
    expect(resolveGitManagerWorkingTree({ isRepo: true, hasWorkingTreeChanges: false })).toBe(
      "clean",
    );
  });

  it("treats a status Git could not read as unreadable, not clean", () => {
    // A broken HEAD or .git/config reports isRepo false with no working-tree changes.
    expect(resolveGitManagerWorkingTree({ isRepo: false, hasWorkingTreeChanges: false })).toBe(
      "unreadable",
    );
  });
});

describe("resolveGitManagerTabTransition", () => {
  it("selects History when the panel opens on, or switches to, a clean checkout", () => {
    expect(resolveGitManagerTabTransition(null, inputs("clean"), "changes")).toBe("history");
    expect(resolveGitManagerTabTransition(inputs("loading"), inputs("clean"), "changes")).toBe(
      "history",
    );
  });

  it("keeps the tab when the panel opens on a dirty, loading or unreadable checkout", () => {
    expect(resolveGitManagerTabTransition(null, inputs("dirty"), "changes")).toBeNull();
    expect(resolveGitManagerTabTransition(null, inputs("loading"), "changes")).toBeNull();
    expect(resolveGitManagerTabTransition(null, inputs("unreadable"), "changes")).toBeNull();
  });

  it("selects History when a dirty checkout becomes clean", () => {
    expect(resolveGitManagerTabTransition(inputs("dirty"), inputs("clean"), "changes")).toBe(
      "history",
    );
  });

  it("keeps the tab while Git cannot read the repository and after it recovers", () => {
    expect(
      resolveGitManagerTabTransition(inputs("dirty"), inputs("unreadable"), "changes"),
    ).toBeNull();
    expect(
      resolveGitManagerTabTransition(inputs("clean"), inputs("unreadable"), "changes"),
    ).toBeNull();
    expect(
      resolveGitManagerTabTransition(inputs("unreadable"), inputs("clean"), "changes"),
    ).toBeNull();
    expect(
      resolveGitManagerTabTransition(inputs("unreadable"), inputs("dirty"), "changes"),
    ).toBeNull();
  });

  it("keeps the tab when nothing about the working tree changed", () => {
    expect(resolveGitManagerTabTransition(inputs("clean"), inputs("clean"), "changes")).toBeNull();
    expect(resolveGitManagerTabTransition(inputs("clean"), inputs("dirty"), "history")).toBeNull();
    expect(
      resolveGitManagerTabTransition(inputs("clean"), inputs("loading"), "changes"),
    ).toBeNull();
  });

  it("selects Changes when a merge appears or is pending on open, even from Tags", () => {
    expect(resolveGitManagerTabTransition(null, inputs("dirty", true), "history")).toBe("changes");
    expect(resolveGitManagerTabTransition(null, inputs("clean", true), "history")).toBe("changes");
    expect(resolveGitManagerTabTransition(inputs("dirty"), inputs("dirty", true), "tags")).toBe(
      "changes",
    );
  });

  it("lets the user leave Changes while the merge stays pending", () => {
    expect(
      resolveGitManagerTabTransition(inputs("dirty", true), inputs("clean", true), "history"),
    ).toBeNull();
  });

  it("selects History when a merge ends on a clean checkout", () => {
    expect(resolveGitManagerTabTransition(inputs("clean", true), inputs("clean"), "changes")).toBe(
      "history",
    );
    expect(
      resolveGitManagerTabTransition(inputs("dirty", true), inputs("dirty"), "changes"),
    ).toBeNull();
  });

  it("never pulls the user off the Tags tab for a clean transition", () => {
    expect(resolveGitManagerTabTransition(null, inputs("clean"), "tags")).toBeNull();
    expect(resolveGitManagerTabTransition(inputs("dirty"), inputs("clean"), "tags")).toBeNull();
    expect(
      resolveGitManagerTabTransition(inputs("clean", true), inputs("clean"), "tags"),
    ).toBeNull();
  });
});
