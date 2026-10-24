// @vitest-environment happy-dom

import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { EnvironmentId, ThreadId, type ReviewReadFileVersionResult } from "@bibcode/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  versions: new Map<string, ReviewReadFileVersionResult>(),
  requested: [] as string[],
  codeView: [] as Array<Record<string, unknown>>,
  scrollTo: vi.fn(),
}));

vi.mock("@effect/atom-react", async () => {
  const { DEFAULT_RESOLVED_KEYBINDINGS } = await import("@bibcode/shared/keybindings");
  return { useAtomValue: () => DEFAULT_RESOLVED_KEYBINDINGS };
});

vi.mock("~/state/server", () => ({ primaryServerKeybindingsAtom: {} }));

vi.mock("~/state/review", () => ({
  reviewEnvironment: {
    fileVersion: (target: { input: { version: unknown } }) => ({
      key: JSON.stringify(target.input.version),
    }),
  },
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: { key: string } | null) => {
    if (atom) h.requested.push(atom.key);
    return {
      data: atom ? (h.versions.get(atom.key) ?? null) : null,
      error: null,
      isPending: atom !== null && !h.versions.has(atom.key),
    };
  },
}));

vi.mock("./AnnotatableCodeView", () => ({
  AnnotatableCodeView: (props: Record<string, unknown>) => {
    h.codeView.push(props);
    const viewerRef = props["viewerRef"] as { current: unknown } | undefined;
    if (viewerRef) viewerRef.current = { scrollTo: h.scrollTo };
    return <div data-testid="code-view" tabIndex={0} />;
  },
}));

import { useDiffPanelStore } from "~/diffPanelStore";

import {
  DiffCompareView,
  parseContextLines,
  type CompareLineFilter,
  type DiffCompareViewProps,
} from "./DiffCompareView";

const environmentId = EnvironmentId.make("environment-1");
const threadRef = { environmentId, threadId: ThreadId.make("thread-1") };
const OLD_A = "a".repeat(40);
const NEW_A = "b".repeat(40);
const OLD_B = "c".repeat(40);
const NEW_B = "d".repeat(40);

function lines(replace: Record<number, string> = {}): string {
  return Array.from(
    { length: 12 },
    (_, index) => `${replace[index + 1] ?? `line ${index + 1}`}\n`,
  ).join("");
}

function modified(path: string, oldId: string, newId: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    `index ${oldId}..${newId} 100644`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -5,3 +5,3 @@",
    " line 5",
    "-line 6",
    "+line six",
    " line 7",
  ].join("\n");
}

function parse(...sections: string[]): FileDiffMetadata[] {
  return parsePatchFiles(`${sections.join("\n")}\n`, "compare-view-test").flatMap(
    (patch) => patch.files,
  );
}

const blobKey = (oid: string) => JSON.stringify({ _tag: "blob", oid });
const worktreeKey = (path: string, expectedOid: string) =>
  JSON.stringify({ _tag: "worktree", path, expectedOid });

function lastCodeView(): Record<string, unknown> {
  const props = h.codeView.at(-1);
  expect(props, "the diff renders").toBeDefined();
  return props!;
}

describe("DiffCompareView", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onRevalidatePatch = vi.fn();
  const onLinesChange = vi.fn();
  const onContextLinesChange = vi.fn();
  const allLines: CompareLineFilter = {
    lines: "all",
    contextLines: 3,
    contextFiles: null,
    contextPending: false,
    contextUnavailableReason: null,
    onLinesChange,
    onContextLinesChange,
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    h.versions.clear();
    h.requested.length = 0;
    h.codeView.length = 0;
    h.scrollTo.mockClear();
    onRevalidatePatch.mockClear();
    onLinesChange.mockClear();
    onContextLinesChange.mockClear();
    useDiffPanelStore.setState({ compareFileByThreadKey: {}, compareFiltersByThreadKey: {} });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function render(files: FileDiffMetadata[], overrides: Partial<DiffCompareViewProps> = {}) {
    await act(async () => {
      root.render(
        <DiffCompareView
          composerDraftTarget={threadRef}
          cwd="/repo"
          environmentId={environmentId}
          files={files}
          liveTurnPatches={false}
          options={{ theme: "pierre-light" }}
          scope="working-tree"
          sectionId="unstaged"
          sectionTitle="Working tree"
          lineFilter={allLines}
          threadRef={threadRef}
          onRevalidatePatch={onRevalidatePatch}
          {...overrides}
        />,
      );
    });
  }

  const options = () => [...container.querySelectorAll<HTMLElement>('[role="option"]')];
  const listbox = () => container.querySelector<HTMLElement>('[role="listbox"]')!;

  it("reads the selected file's versions and fills Git's hunks with them", async () => {
    const files = parse(modified("src/a.ts", OLD_A, NEW_A), modified("src/b.ts", OLD_B, NEW_B));
    await render(files);
    expect(h.requested).toContain(blobKey(OLD_A));
    expect(h.requested).toContain(worktreeKey("src/a.ts", NEW_A));
    expect(container.textContent).toContain("Loading full file…");
    expect(lastCodeView()["options"]).toMatchObject({ diffStyle: "split", expandUnchanged: false });

    h.versions.set(blobKey(OLD_A), { _tag: "text", contents: lines(), byteLength: 1 });
    h.versions.set(worktreeKey("src/a.ts", NEW_A), {
      _tag: "text",
      contents: lines({ 6: "line six" }),
      byteLength: 1,
    });
    await render(files);
    const [file] = lastCodeView()["files"] as Array<{ fileDiff: FileDiffMetadata }>;
    expect(file!.fileDiff.isPartial).toBe(false);
    expect(file!.fileDiff.additionLines).toHaveLength(12);
    expect(lastCodeView()["options"]).toMatchObject({ expandUnchanged: true });
    expect(container.textContent).not.toContain("Loading full file…");
  });

  it("shows Changes only from the context patch, with gaps, and comments on the default hunks", async () => {
    const [defaultFile] = parse(modified("src/a.ts", OLD_A, NEW_A));
    const [contextFile] = parse(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        `index ${OLD_A}..${NEW_A} 100644`,
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -6 +6 @@",
        "-line 6",
        "+line six",
      ].join("\n"),
    );
    h.versions.set(blobKey(OLD_A), { _tag: "text", contents: lines(), byteLength: 1 });
    h.versions.set(worktreeKey("src/a.ts", NEW_A), {
      _tag: "text",
      contents: lines({ 6: "line six" }),
      byteLength: 1,
    });
    const changesOnly = { ...allLines, lines: "changes" as const, contextLines: 0 };
    await render([defaultFile!], {
      lineFilter: { ...changesOnly, contextFiles: [contextFile!] },
    });
    const view = lastCodeView();
    expect(view["options"]).toMatchObject({ expandUnchanged: false });
    const [shown] = view["files"] as Array<{
      fileDiff: FileDiffMetadata;
      commentFileDiff: FileDiffMetadata;
    }>;
    expect(shown!.fileDiff.isPartial, "the full files fill the gaps for expansion").toBe(false);
    expect(shown!.fileDiff.hunks[0]!.additionCount, "Git's -U0 hunk").toBe(1);
    expect(shown!.commentFileDiff).toBe(defaultFile);

    // Still loading the context patch: the default hunks show meanwhile.
    await render([defaultFile!], { lineFilter: { ...changesOnly, contextPending: true } });
    expect(container.textContent).toContain("Loading changes…");
    const [pending] = lastCodeView()["files"] as Array<{ fileDiff: FileDiffMetadata }>;
    expect(pending!.fileDiff.hunks[0]!.additionCount).toBe(3);
  });

  it("switches the line filter and commits the context count after typing stops", async () => {
    vi.useFakeTimers();
    try {
      await render(parse(modified("src/a.ts", OLD_A, NEW_A)));
      expect(container.querySelector('input[type="number"]'), "All lines has no count").toBeNull();
      const changesToggle = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Changes only",
      )!;
      await act(async () => changesToggle.click());
      expect(onLinesChange).toHaveBeenCalledWith("changes");

      await render(parse(modified("src/a.ts", OLD_A, NEW_A)), {
        lineFilter: { ...allLines, lines: "changes" },
      });
      const field = container.querySelector<HTMLInputElement>('input[type="number"]')!;
      const type = async (value: string) =>
        act(async () => {
          const setValue = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value",
          )!.set!;
          setValue.call(field, value);
          field.dispatchEvent(new Event("input", { bubbles: true }));
        });
      await type("1");
      await type("12");
      await act(async () => vi.advanceTimersByTime(299));
      expect(onContextLinesChange, "no commit while typing").not.toHaveBeenCalled();
      await act(async () => vi.advanceTimersByTime(1));
      expect(onContextLinesChange).toHaveBeenCalledTimes(1);
      expect(onContextLinesChange).toHaveBeenCalledWith(12);

      await type("100");
      await act(async () => vi.advanceTimersByTime(300));
      expect(onContextLinesChange, "out of range never commits").toHaveBeenCalledTimes(1);
      await act(async () => {
        field.dispatchEvent(new FocusEvent("blur"));
        field.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      });
      expect(field.value, "blur restores the saved count").toBe("3");
    } finally {
      vi.useRealTimers();
    }
  });

  it("disables the count with its reason when the server ignores it", async () => {
    await render(parse(modified("src/a.ts", OLD_A, NEW_A)), {
      lineFilter: {
        ...allLines,
        lines: "changes",
        contextUnavailableReason: "Update the server to change context lines.",
      },
    });
    const field = container.querySelector<HTMLInputElement>('input[type="number"]')!;
    expect(field.disabled).toBe(true);
    const reason = document.getElementById(field.getAttribute("aria-describedby")!);
    expect(reason?.textContent).toBe("Update the server to change context lines.");
    expect(parseContextLines(" 7 ")).toBe(7);
    expect(parseContextLines("-1")).toBeNull();
    expect(parseContextLines("")).toBeNull();
  });

  it("moves between changes with F7, Shift+F7 and the buttons, and stops at the ends", async () => {
    const twoHunks = [
      "diff --git a/src/a.ts b/src/a.ts",
      `index ${OLD_A}..${NEW_A} 100644`,
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -2 +2 @@",
      "-line 2",
      "+line two",
      "@@ -10 +10 @@",
      "-line 10",
      "+line ten",
    ].join("\n");
    await render(parse(twoHunks));
    const button = (label: string) =>
      container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
    expect(button("Previous change").getAttribute("aria-disabled")).toBe("true");
    const diff = container.querySelector<HTMLElement>('[data-testid="code-view"]')!;
    const press = async (init: KeyboardEventInit) =>
      act(async () => {
        diff.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
      });

    await press({ key: "F7" });
    expect(h.scrollTo).toHaveBeenLastCalledWith({
      type: "line",
      id: "src/a.ts",
      lineNumber: 2,
      side: "additions",
      align: "center",
    });
    await act(async () => button("Next change").click());
    expect(h.scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ lineNumber: 10 }));
    expect(button("Next change").getAttribute("aria-disabled")).toBe("true");
    await press({ key: "F7" });
    expect(h.scrollTo, "no more changes past the last").toHaveBeenCalledTimes(2);

    await press({ key: "F7", shiftKey: true });
    expect(h.scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ lineNumber: 2 }));
    expect(button("Previous change").getAttribute("aria-disabled")).toBe("true");
  });

  it("reads two blobs for branch and turn scopes", async () => {
    await render(parse(modified("src/a.ts", OLD_A, NEW_A)), { scope: "branch" });
    expect(h.requested).toContain(blobKey(OLD_A));
    expect(h.requested).toContain(blobKey(NEW_A));
  });

  it("selects with the mouse and with Up and Down, and remembers the file", async () => {
    const files = parse(modified("src/a.ts", OLD_A, NEW_A), modified("src/b.ts", OLD_B, NEW_B));
    await render(files);
    expect(options().map((option) => option.getAttribute("aria-selected"))).toEqual([
      "true",
      "false",
    ]);
    expect(listbox().getAttribute("aria-activedescendant")).toBe(options()[0]!.id);

    await act(async () => {
      listbox().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(useDiffPanelStore.getState().compareFileByThreadKey).toEqual({
      "environment-1:thread-1": "src/b.ts",
    });
    expect(options()[1]!.getAttribute("aria-selected")).toBe("true");
    expect(h.requested).toContain(blobKey(OLD_B));

    await act(async () => {
      options()[0]!.click();
    });
    expect(options()[0]!.getAttribute("aria-selected")).toBe("true");
  });

  it("brings the row End selects into a long list's window", async () => {
    // The list measures a 280px viewport: ten rows plus overscan, not two hundred.
    const height = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      height: 280,
      width: 240,
      top: 0,
      left: 0,
      bottom: 280,
      right: 240,
    } as DOMRect);
    const clientHeight = vi
      .spyOn(HTMLElement.prototype, "clientHeight", "get")
      .mockReturnValue(280);
    try {
      const files = parse(
        ...Array.from({ length: 200 }, (_, index) =>
          modified(`src/file-${String(index).padStart(3, "0")}.ts`, OLD_A, NEW_A),
        ),
      );
      await render(files);
      expect(options().at(-1)?.title).not.toBe("src/file-199.ts");
      await act(async () => {
        listbox().dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
      });
      expect(options().at(-1)?.title).toBe("src/file-199.ts");
      expect(options().at(-1)?.getAttribute("aria-selected")).toBe("true");
      expect(listbox().getAttribute("aria-activedescendant")).toBe(options().at(-1)!.id);
    } finally {
      height.mockRestore();
      clientHeight.mockRestore();
    }
  });

  it("asks for the patch once when the working file moved past it, then says it is changing", async () => {
    const first = parse(modified("src/a.ts", OLD_A, NEW_A));
    h.versions.set(blobKey(OLD_A), { _tag: "text", contents: lines(), byteLength: 1 });
    h.versions.set(worktreeKey("src/a.ts", NEW_A), {
      _tag: "unavailable",
      reason: "changed",
      byteLength: 9,
    });
    await render(first);
    expect(onRevalidatePatch).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("This file is changing.");
    await render(first);
    expect(onRevalidatePatch, "the same result does not ask again").toHaveBeenCalledTimes(1);

    // The new patch names the file's new content, which moved on again.
    const second = parse(modified("src/a.ts", OLD_A, NEW_B));
    h.versions.set(worktreeKey("src/a.ts", NEW_B), {
      _tag: "unavailable",
      reason: "changed",
      byteLength: 9,
    });
    await render(second);
    expect(container.textContent).toContain("This file is changing.");
    expect(onRevalidatePatch).toHaveBeenCalledTimes(1);

    const refresh = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Refresh",
    )!;
    await act(async () => refresh.click());
    expect(onRevalidatePatch).toHaveBeenCalledTimes(2);
  });

  it("explains files that have nothing more to show, without reading them", async () => {
    const files = parse(
      [
        "diff --git a/image.png b/image.png",
        `index ${OLD_A}..${NEW_A} 100644`,
        "Binary files a/image.png and b/image.png differ",
      ].join("\n"),
    );
    await render(files);
    expect(container.textContent).toContain(
      "Binary file. Use Open with to compare it in a diff app.",
    );
    expect(h.requested).toEqual([]);
    expect(h.codeView).toEqual([]);
  });

  it("shows Git's hunks with the reason when an older server printed short IDs", async () => {
    await render(parse(modified("src/a.ts", "1111111", "2222222")));
    expect(container.textContent).toContain("Full files need a newer server.");
    expect(h.requested).toEqual([]);
    expect(
      (lastCodeView()["files"] as Array<{ fileDiff: FileDiffMetadata }>)[0]!.fileDiff.isPartial,
    ).toBe(true);
  });

  it("filters by name and status, counts what is shown, and clears", async () => {
    const files = parse(modified("src/a.ts", OLD_A, NEW_A), modified("src/b.ts", OLD_B, NEW_B));
    await render(files);
    const filter = container.querySelector<HTMLInputElement>('input[aria-label="Filter files"]')!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(filter, "B.TS");
      filter.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.textContent).toContain("1 of 2 files");
    expect(options().map((option) => option.title)).toEqual(["src/b.ts"]);

    await act(async () => {
      useDiffPanelStore.getState().setCompareFilters(threadRef, { status: "deleted", query: "" });
    });
    expect(container.textContent).toContain("No files match these filters.");
    const clear = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Clear filters",
    )!;
    await act(async () => clear.click());
    expect(options()).toHaveLength(2);
    expect(container.textContent).not.toContain("of 2 files");
  });
});
