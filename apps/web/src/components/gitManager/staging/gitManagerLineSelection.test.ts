import { describe, expect, it } from "vite-plus/test";

import {
  createLineSelection,
  isLineSelected,
  resolveSelectionMutationFailure,
  resolveSelectionType,
  toWireSelection,
  withLineSelection,
  withRangeSelection,
  withSelectAll,
  withSelectNone,
  withToggleLine,
} from "./gitManagerLineSelection";

describe("gitManagerLineSelection", () => {
  it.each(["all", "none"] as const)(
    "creates an immutable %s selection and toggles one diverging line",
    (kind) => {
      const selection = createLineSelection(kind);
      const next = withToggleLine(selection, 4);

      expect(selection.type).toBe(kind);
      expect([...selection.diverging]).toEqual([]);
      expect(next).not.toBe(selection);
      expect(next.type).toBe("partial");
      expect([...next.diverging]).toEqual([4]);
      expect([...selection.diverging]).toEqual([]);
    },
  );

  it("sets one line explicitly without mutating the previous selection", () => {
    const selection = createLineSelection("none");
    const selected = withLineSelection(selection, 2, true);
    const cleared = withLineSelection(selected, 2, false);

    expect(selected).not.toBe(selection);
    expect(isLineSelected(selected, 2)).toBe(true);
    expect(isLineSelected(selection, 2)).toBe(false);
    expect(cleared).not.toBe(selected);
    expect(isLineSelected(cleared, 2)).toBe(false);
  });

  it("selects an inclusive reversed drag range", () => {
    const selection = createLineSelection("none");
    const next = withRangeSelection(selection, 5, 2, true);

    expect(next).not.toBe(selection);
    expect([...next.diverging]).toEqual([2, 3, 4, 5]);
    expect([1, 2, 3, 4, 5, 6].map((index) => isLineSelected(next, index))).toEqual([
      false,
      true,
      true,
      true,
      true,
      false,
    ]);
  });

  it("collapses select-all and select-none back to pure selections", () => {
    const partial = withLineSelection(createLineSelection("none", [1, 3]), 1, true);
    const all = withSelectAll(partial);
    const none = withSelectNone(all);

    expect(all).not.toBe(partial);
    expect(all.type).toBe("all");
    expect([...all.diverging]).toEqual([]);
    expect(none).not.toBe(all);
    expect(none.type).toBe("none");
    expect([...none.diverging]).toEqual([]);
  });

  it("resolves none, partial, and all against selectable diff lines", () => {
    const none = createLineSelection("none", [1, 3]);
    const partial = withLineSelection(none, 1, true);
    const all = withLineSelection(partial, 3, true);

    expect(resolveSelectionType(none)).toBe("none");
    expect(resolveSelectionType(partial)).toBe("partial");
    expect(resolveSelectionType(all)).toBe("all");
    expect(isLineSelected(all, 2)).toBe(false);
  });

  it("resolves an empty file to none", () => {
    expect(resolveSelectionType(createLineSelection("all", []))).toBe("none");
  });

  it("serializes selected 0-based diff-body indices with their generation", () => {
    const selectable = [0, 2, 5];
    const selection = withLineSelection(
      withLineSelection(createLineSelection("none", selectable), 0, true),
      5,
      true,
    );

    expect(toWireSelection(selection, "src/file.ts", 42)).toEqual({
      path: "src/file.ts",
      selectedLines: [0, 5],
      baseGeneration: 42,
    });
    expect(toWireSelection(selection, "src/file.ts", 42)).not.toHaveProperty("patch");
  });

  it("keeps a stale selection untouched and never requests a blind retry", () => {
    const selection = withLineSelection(createLineSelection("none", [2]), 2, true);
    const resolution = resolveSelectionMutationFailure(selection, {
      code: "stale-selection",
      message: "The selected diff changed; refresh it and select the lines again.",
    });

    expect(resolution.selection).toBe(selection);
    expect(resolution.message).toBe(
      "The selected diff changed; refresh it and select the lines again.",
    );
    expect(resolution.retry).toBe(false);
    expect(resolution.stale).toBe(true);
  });
});
