// @vitest-environment happy-dom

import type { FileDiffMetadata } from "@pierre/diffs";
import { act, useCallback, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { GitManagerStagingGutter } from "./GitManagerStagingGutter";
import {
  readCurrentWireSelection,
  selectPartialStagingCommand,
} from "../changes/GitManagerDiffPane";
import {
  createLineSelection,
  type GitManagerLineSelection,
  withLineSelection,
} from "./gitManagerLineSelection";

const FILE_DIFF: FileDiffMetadata = {
  name: "file.ts",
  type: "change",
  hunks: [
    {
      collapsedBefore: 0,
      additionStart: 1,
      additionCount: 3,
      additionLines: 2,
      additionLineIndex: 0,
      deletionStart: 1,
      deletionCount: 3,
      deletionLines: 2,
      deletionLineIndex: 0,
      hunkContent: [
        { type: "change", deletions: 1, deletionLineIndex: 0, additions: 1, additionLineIndex: 0 },
        { type: "context", lines: 1, additionLineIndex: 1, deletionLineIndex: 1 },
        { type: "change", deletions: 1, deletionLineIndex: 2, additions: 1, additionLineIndex: 2 },
      ],
      splitLineStart: 0,
      splitLineCount: 3,
      unifiedLineStart: 0,
      unifiedLineCount: 5,
      noEOFCRDeletions: false,
      noEOFCRAdditions: false,
    },
  ],
  splitLineCount: 3,
  unifiedLineCount: 5,
  isPartial: true,
  deletionLines: ["old", "context", "third"],
  additionLines: ["new", "context", "fourth"],
};

const fileDiff = () => FILE_DIFF;

const selectable = [0, 1, 3, 4];

interface InteractiveHarnessProps {
  readonly onChange: (selection: GitManagerLineSelection) => void;
}

function InteractiveHarness({ onChange }: InteractiveHarnessProps) {
  const [selection, setSelection] = useState(() => createLineSelection("none", selectable));
  const handleChange = useCallback(
    (next: GitManagerLineSelection) => {
      onChange(next);
      setSelection(next);
    },
    [onChange],
  );
  return (
    <GitManagerStagingGutter
      disabledReason={null}
      fileDiff={fileDiff()}
      selection={selection}
      onSelectionChange={handleChange}
    />
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("GitManagerStagingGutter", () => {
  it("labels line checkboxes and exposes mixed hunk state", () => {
    const selection = withLineSelection(createLineSelection("none", selectable), 0, true);
    const markup = renderToStaticMarkup(
      <GitManagerStagingGutter
        disabledReason={null}
        fileDiff={fileDiff()}
        selection={selection}
        onSelectionChange={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="Toggle line 1, deletions"');
    expect(markup).toContain('aria-label="Toggle line 1, additions"');
    expect(markup).toContain('aria-checked="mixed"');
  });

  it("renders the distinct partial stage and partial unstage actions", () => {
    const baseProps = {
      disabledReason: null,
      fileDiff: fileDiff(),
      selection: createLineSelection("none", selectable),
      onSelectionChange: vi.fn(),
      onApplySelection: vi.fn(),
    } as const;

    expect(
      renderToStaticMarkup(<GitManagerStagingGutter {...baseProps} area="unstaged" />),
    ).toContain("Stage selected lines");
    expect(
      renderToStaticMarkup(<GitManagerStagingGutter {...baseProps} area="staged" />),
    ).toContain("Unstage selected lines");
  });

  it("selects stage for unstaged coordinates and unstage for staged coordinates", () => {
    const stagePartial = vi.fn();
    const unstagePartial = vi.fn();

    expect(selectPartialStagingCommand("unstaged", { stagePartial, unstagePartial })).toBe(
      stagePartial,
    );
    expect(selectPartialStagingCommand("staged", { stagePartial, unstagePartial })).toBe(
      unstagePartial,
    );
  });

  it("reads the current selection snapshot only when the action is pressed", () => {
    let current = createLineSelection("none", selectable);
    const readSelection = () => current;
    current = withLineSelection(current, 4, true);

    const snapshot = readCurrentWireSelection(readSelection, "file.ts", 19);

    expect(snapshot.selection).toBe(current);
    expect(snapshot.wire).toEqual({
      path: "file.ts",
      selectedLines: [4],
      baseGeneration: 19,
    });
  });

  it("does not invoke the staging action when selection alone changes", async () => {
    const onApplySelection = vi.fn();
    const onSelectionChange = vi.fn();
    await act(async () =>
      root.render(
        <GitManagerStagingGutter
          area="unstaged"
          disabledReason={null}
          fileDiff={fileDiff()}
          selection={createLineSelection("none", selectable)}
          onApplySelection={onApplySelection}
          onSelectionChange={onSelectionChange}
        />,
      ),
    );

    await act(async () =>
      container
        .querySelector<HTMLElement>('[data-line-index="0"]')!
        .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })),
    );

    expect(onSelectionChange).toHaveBeenCalledOnce();
    expect(onApplySelection).not.toHaveBeenCalled();
  });

  it("supports Space and Shift+Space range selection", async () => {
    const onChange = vi.fn();
    await act(async () => root.render(<InteractiveHarness onChange={onChange} />));

    const first = container.querySelector<HTMLElement>('[data-line-index="0"]')!;
    await act(async () =>
      first.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: " " })),
    );
    const last = container.querySelector<HTMLElement>('[data-line-index="4"]')!;
    await act(async () =>
      last.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: " ", shiftKey: true })),
    );

    expect([...onChange.mock.calls.at(-1)![0].diverging]).toEqual([0, 1, 3, 4]);
  });

  it("drag-selects an inclusive range and terminates when the pointer leaves", async () => {
    const onChange = vi.fn();
    await act(async () => root.render(<InteractiveHarness onChange={onChange} />));

    await act(async () =>
      container
        .querySelector<HTMLElement>('[data-line-index="0"]')!
        .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 })),
    );
    await act(async () =>
      container
        .querySelector<HTMLElement>('[data-line-index="4"]')!
        .dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1 })),
    );
    await act(async () =>
      container.querySelector<HTMLElement>('[data-staging-gutter="true"]')!.dispatchEvent(
        new PointerEvent("pointerout", {
          bubbles: true,
          pointerId: 1,
          relatedTarget: document.body,
        }),
      ),
    );
    await act(async () =>
      container
        .querySelector<HTMLElement>('[data-line-index="0"]')!
        .dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1 })),
    );

    expect([...onChange.mock.calls.at(-1)![0].diverging]).toEqual([0, 1, 3, 4]);
  });

  it.each([
    ["A commit is in progress.", "A commit is in progress."],
    ["Show whitespace to select individual lines.", "Show whitespace to select individual lines."],
  ])("disables selection and renders its reason", (disabledReason, expected) => {
    const markup = renderToStaticMarkup(
      <GitManagerStagingGutter
        disabledReason={disabledReason}
        fileDiff={fileDiff()}
        selection={createLineSelection("none", selectable)}
        onSelectionChange={vi.fn()}
      />,
    );

    expect(markup).toContain(expected);
    expect(markup).toContain("disabled");
  });

  it.each([
    ["binary" as const, undefined, "Binary files support whole-file staging only."],
    ["submodule" as const, undefined, "Submodules support whole-file staging only."],
    ["text" as const, { byteLength: 4_375_000, longestLineLength: 10 }, "too large"],
    ["text" as const, { byteLength: 70_000_000, longestLineLength: 10 }, "cannot be rendered"],
  ])("does not offer a gutter for %s payloads", (diffKind, payload, reason) => {
    const markup = renderToStaticMarkup(
      <GitManagerStagingGutter
        {...(payload === undefined ? {} : { payload })}
        diffKind={diffKind}
        disabledReason={null}
        fileDiff={fileDiff()}
        selection={createLineSelection("none", selectable)}
        onSelectionChange={vi.fn()}
      />,
    );

    expect(markup).toContain(reason);
    expect(markup).not.toContain("data-line-index");
  });

  it("renders the whole-file fallback reason for a renamed path", () => {
    const renamed = { ...fileDiff(), prevName: "old.ts", type: "rename-changed" as const };
    const markup = renderToStaticMarkup(
      <GitManagerStagingGutter
        disabledReason={null}
        fileDiff={renamed}
        selection={createLineSelection("none", selectable)}
        onSelectionChange={vi.fn()}
      />,
    );

    expect(markup).toContain("Renamed files support whole-file staging only.");
    expect(markup).not.toContain("data-line-index");
  });
});
