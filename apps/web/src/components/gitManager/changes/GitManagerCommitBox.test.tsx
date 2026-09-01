// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useSourceControlPanelStore } from "../../../sourceControlPanelStore";
import { GitManagerCommitBox } from "./GitManagerCommitBox";
import { GitManagerUndoCommitStrip } from "./GitManagerUndoCommitStrip";

let container: HTMLDivElement;
let root: Root | null;

async function renderCommitBox(
  overrides: Partial<React.ComponentProps<typeof GitManagerCommitBox>> = {},
) {
  const onCommit = vi.fn(() => Promise.resolve());
  await act(async () =>
    root?.render(
      <GitManagerCommitBox
        branch="main"
        disabledReason={null}
        includedPaths={[]}
        isBusy={false}
        scope={{ environmentId: "environment-1" as never, cwd: "/repo" }}
        onCommit={onCommit}
        {...overrides}
      />,
    ),
  );
  return { onCommit };
}

async function changeInput(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function buttonWithText(text: string): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find(
    (candidate) =>
      (candidate.textContent?.includes(text) ?? false) ||
      candidate.getAttribute("aria-label") === text,
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing button: ${text}`);
  return button;
}

function checkboxWithLabel(text: string): HTMLElement {
  const label = [...document.querySelectorAll("label")].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  const checkbox = label?.querySelector<HTMLElement>("[role='checkbox']");
  if (checkbox === null || checkbox === undefined) throw new Error(`Missing checkbox: ${text}`);
  return checkbox;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useSourceControlPanelStore.setState({ byThreadKey: {}, byCwdKey: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("GitManagerCommitBox", () => {
  it("disables commit without a summary or included file", async () => {
    await renderCommitBox();

    const commit = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Commit 0 files to main"),
    );
    expect(commit?.disabled).toBe(true);
  });

  it("enables commit with the single-file placeholder summary", async () => {
    await renderCommitBox({ includedPaths: ["src/panel.tsx"] });

    expect(buttonWithText("Commit 1 files to main").disabled).toBe(false);
    expect(container.querySelector<HTMLInputElement>("#git-manager-summary")?.placeholder).toBe(
      "Update panel.tsx",
    );
  });

  it("shows a hint after the summary exceeds 50 characters", async () => {
    await renderCommitBox({ includedPaths: ["src/panel.tsx"] });
    const summary = container.querySelector<HTMLInputElement>("#git-manager-summary")!;

    await changeInput(summary, "x".repeat(51));

    expect(container.textContent).toContain("over the ideal 50-character length");
  });

  it("passes all commit option flags to the action payload", async () => {
    const { onCommit } = await renderCommitBox({ includedPaths: ["src/panel.tsx"] });
    await changeInput(
      container.querySelector<HTMLInputElement>("#git-manager-summary")!,
      "Add commit UI",
    );

    await act(async () => buttonWithText("Commit Options").click());
    for (const label of ["Bypass Commit Hooks", "Signed-off-by", "Allow Empty"]) {
      const checkbox = checkboxWithLabel(label);
      await act(async () => {
        checkbox.focus();
        checkbox.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: " " }),
        );
        checkbox.dispatchEvent(
          new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key: " " }),
        );
      });
    }
    await act(async () => buttonWithText("Commit 1 files to main").click());

    await vi.waitFor(() =>
      expect(onCommit).toHaveBeenCalledWith(
        expect.objectContaining({
          noVerify: true,
          signoff: true,
          allowEmpty: true,
          amend: false,
        }),
      ),
    );
  });

  it("hides the undo strip while amend mode is active", async () => {
    await renderCommitBox({
      includedPaths: ["src/panel.tsx"],
      latestCommit: { committedAtMs: Date.now(), isMerge: false },
      onUndo: vi.fn(() => Promise.resolve(null)),
    });
    expect(container.textContent).toContain("Undo");

    await act(async () => buttonWithText("Amend Last Commit").click());

    expect(container.textContent).not.toContain("Undo");
    expect(container.textContent).toContain("Stop Amending");
  });

  it("restores undo fields without appending or parsing co-author trailers", async () => {
    await renderCommitBox({
      latestCommit: { committedAtMs: Date.now(), isMerge: false },
      onUndo: vi.fn(() =>
        Promise.resolve({
          summary: "Restore summary",
          description: "Restore description verbatim",
          coAuthors: [{ name: "Ada Lovelace", email: "ada@example.test" }],
        }),
      ),
    });

    await act(async () => buttonWithText("Undo").click());
    await act(async () => buttonWithText("Undo Commit").click());

    await vi.waitFor(() =>
      expect(useSourceControlPanelStore.getState().byCwdKey["environment-1::/repo"]?.message).toBe(
        "Restore summary\n\nRestore description verbatim",
      ),
    );
    expect(container.textContent).toContain("Ada Lovelace <ada@example.test>");
    expect(
      useSourceControlPanelStore.getState().byCwdKey["environment-1::/repo"]?.message,
    ).not.toContain("Co-Authored-By");
  });
});

describe("GitManagerUndoCommitStrip", () => {
  it("is hidden while amending or while an operation is in flight", async () => {
    const onUndo = vi.fn(() => Promise.resolve());
    await act(async () =>
      root?.render(
        <GitManagerUndoCommitStrip
          committedAtMs={Date.now()}
          isAmending
          isBusy={false}
          isMerge={false}
          workingTreeDirty={false}
          onUndo={onUndo}
        />,
      ),
    );
    expect(container.textContent).toBe("");

    await act(async () =>
      root?.render(
        <GitManagerUndoCommitStrip
          committedAtMs={Date.now()}
          isAmending={false}
          isBusy
          isMerge={false}
          workingTreeDirty={false}
          onUndo={onUndo}
        />,
      ),
    );
    expect(container.textContent).toBe("");
  });

  it("requires explicit confirmation before undoing", async () => {
    const onUndo = vi.fn(() => Promise.resolve());
    await act(async () =>
      root?.render(
        <GitManagerUndoCommitStrip
          committedAtMs={Date.now()}
          isAmending={false}
          isBusy={false}
          isMerge
          workingTreeDirty
          onUndo={onUndo}
        />,
      ),
    );

    await act(async () => buttonWithText("Undo").click());
    expect(onUndo).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("reset to its first parent");
    expect(document.body.textContent).toContain("current working tree changes will remain");

    await act(async () => buttonWithText("Undo Commit").click());
    await vi.waitFor(() => expect(onUndo).toHaveBeenCalledOnce());
  });
});
