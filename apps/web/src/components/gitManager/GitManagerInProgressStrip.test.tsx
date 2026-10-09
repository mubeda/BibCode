// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <header>{children}</header>,
  DialogPopup: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

import { GitManagerInProgressStrip } from "./GitManagerInProgressStrip";

const MERGE = { kind: "merge", current: null, total: null } as const;

let container: HTMLDivElement;
let root: Root | null;

function buttonWithText(text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === text,
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing button: ${text}`);
  return button;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

describe("GitManagerInProgressStrip", () => {
  it("disables only Continue with a continue-only reason", async () => {
    await act(async () =>
      root?.render(
        <GitManagerInProgressStrip
          blocked={null}
          continueDisabledReason="Resolve and stage every conflicted file first."
          continueLabel="Commit merge"
          operation={MERGE}
          onAbort={vi.fn()}
          onContinue={vi.fn()}
        />,
      ),
    );

    expect(buttonWithText("Commit merge")).toMatchObject({
      disabled: true,
      title: "Resolve and stage every conflicted file first.",
    });
    expect(buttonWithText("Abort").disabled).toBe(false);
    expect(container.textContent).toContain("Resolve and stage every conflicted file first.");
  });

  it("disables both actions with an operation-wide reason", async () => {
    await act(async () =>
      root?.render(
        <GitManagerInProgressStrip
          blocked={null}
          continueDisabledReason="Resolve and stage every conflicted file first."
          disabledReason="A merge is running."
          operation={MERGE}
          onAbort={vi.fn()}
          onContinue={vi.fn()}
        />,
      ),
    );

    expect(buttonWithText("Continue")).toMatchObject({
      disabled: true,
      title: "A merge is running.",
    });
    expect(buttonWithText("Abort")).toMatchObject({
      disabled: true,
      title: "A merge is running.",
    });
  });
});
