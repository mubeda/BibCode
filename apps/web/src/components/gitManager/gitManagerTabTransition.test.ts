import { describe, expect, it } from "vite-plus/test";

import {
  resolveGitManagerTabTransition,
  resolveGitManagerTabTransitionBaseline,
  resolveGitManagerWorkingTree,
  type GitManagerTabTransitionInputs,
  type GitManagerWorkingTree,
} from "./gitManagerTabTransition";

const inputs = (
  workingTree: GitManagerWorkingTree,
  mergePending: boolean | null = false,
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

  it("does not treat unknown refs as a merge ending on a clean checkout", () => {
    expect(
      resolveGitManagerTabTransition(inputs("clean", true), inputs("clean", null), "changes"),
    ).toBeNull();
    expect(
      resolveGitManagerTabTransition(inputs("dirty", true), inputs("clean", null), "changes"),
    ).toBeNull();
  });

  it("still applies opening rules when the initial merge state is unknown", () => {
    expect(resolveGitManagerTabTransition(null, inputs("clean", null), "changes")).toBe("history");
    expect(
      resolveGitManagerTabTransition(inputs("loading", null), inputs("clean", false), "changes"),
    ).toBe("history");
    expect(
      resolveGitManagerTabTransition(inputs("clean", null), inputs("clean", true), "history"),
    ).toBe("changes");
    expect(
      resolveGitManagerTabTransition(inputs("loading", null), inputs("loading", true), "history"),
    ).toBe("changes");
  });

  it("never pulls the user off the Tags tab for a clean transition", () => {
    expect(resolveGitManagerTabTransition(null, inputs("clean"), "tags")).toBeNull();
    expect(resolveGitManagerTabTransition(inputs("dirty"), inputs("clean"), "tags")).toBeNull();
    expect(
      resolveGitManagerTabTransition(inputs("clean", true), inputs("clean"), "tags"),
    ).toBeNull();
  });
});

describe("resolveGitManagerTabTransitionBaseline", () => {
  it.each([
    { workingTree: "clean", tab: null },
    { workingTree: "dirty", tab: "history" },
    { workingTree: "unreadable", tab: null },
  ] as const)(
    "compares settled statuses across loading after a $workingTree observation",
    ({ workingTree, tab }) => {
      const settled = inputs(workingTree);
      const baseline = resolveGitManagerTabTransitionBaseline(settled, inputs("loading"));

      expect(baseline).toEqual(settled);
      expect(resolveGitManagerTabTransition(baseline, inputs("clean"), "changes")).toBe(tab);
      expect(resolveGitManagerTabTransitionBaseline(baseline, inputs("clean"))).toEqual(
        inputs("clean"),
      );
    },
  );

  it("keeps an initial loading observation so opening on a clean checkout still selects History", () => {
    const baseline = resolveGitManagerTabTransitionBaseline(null, inputs("loading"));

    expect(baseline).toEqual(inputs("loading"));
    expect(resolveGitManagerTabTransition(baseline, inputs("clean"), "changes")).toBe("history");
  });

  it.each([false, true])("keeps a known merge state of %s while refs reload", (mergePending) => {
    const settled = inputs("clean", mergePending);
    const baseline = resolveGitManagerTabTransitionBaseline(settled, inputs("clean", null));

    expect(baseline).toEqual(settled);
    expect(resolveGitManagerTabTransition(baseline, settled, "history")).toBeNull();
  });

  it("retains pending merge knowledge until refs confirm it has ended", () => {
    const baseline = resolveGitManagerTabTransitionBaseline(
      inputs("dirty", true),
      inputs("clean", null),
    );

    expect(baseline).toEqual(inputs("clean", true));
    expect(resolveGitManagerTabTransition(baseline, inputs("clean", false), "changes")).toBe(
      "history",
    );
  });

  it("keeps the initial merge state unknown until refs load", () => {
    const baseline = resolveGitManagerTabTransitionBaseline(null, inputs("loading", null));
    const clean = resolveGitManagerTabTransitionBaseline(baseline, inputs("clean", null));

    expect(baseline).toEqual(inputs("loading", null));
    expect(clean).toEqual(inputs("clean", null));
    expect(resolveGitManagerTabTransitionBaseline(clean, inputs("clean", false))).toEqual(
      inputs("clean", false),
    );
    expect(resolveGitManagerTabTransitionBaseline(clean, inputs("clean", true))).toEqual(
      inputs("clean", true),
    );
  });
});
