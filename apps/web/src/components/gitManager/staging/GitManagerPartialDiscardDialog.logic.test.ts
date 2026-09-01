import { describe, expect, it } from "vite-plus/test";

import { resolvePartialDiscardDialogCopy } from "./GitManagerPartialDiscardDialog.logic";
import { createLineSelection, withRangeSelection } from "./gitManagerLineSelection";

describe("resolvePartialDiscardDialogCopy", () => {
  it("states the exact selected-line count, path, and irrecoverable outcome", () => {
    const selection = withRangeSelection(createLineSelection("none", [0, 1, 3]), 0, 3, true);

    expect(resolvePartialDiscardDialogCopy(selection, "src/file.ts")).toEqual({
      title: "Discard 3 selected lines from src/file.ts?",
      description:
        "This permanently removes the 3 selected working-tree lines from src/file.ts. These changes cannot be recovered.",
      confirmLabel: "Discard 3 lines",
    });
  });

  it("uses singular copy for one selected line", () => {
    const selection = withRangeSelection(createLineSelection("none", [2]), 2, 2, true);

    expect(resolvePartialDiscardDialogCopy(selection, "file.ts")).toMatchObject({
      title: "Discard 1 selected line from file.ts?",
      confirmLabel: "Discard 1 line",
    });
  });
});
