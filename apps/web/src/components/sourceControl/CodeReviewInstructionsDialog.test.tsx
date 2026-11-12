// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: unknown }) =>
    open ? <div role="presentation">{children as never}</div> : null,
  DialogPopup: ({ children }: { children: unknown }) => (
    <div role="dialog">{children as never}</div>
  ),
  DialogHeader: ({ children }: { children: unknown }) => <header>{children as never}</header>,
  DialogTitle: ({ children }: { children: unknown }) => <h2>{children as never}</h2>,
  DialogDescription: ({ children }: { children: unknown }) => <p>{children as never}</p>,
  DialogPanel: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  DialogFooter: ({ children }: { children: unknown }) => <footer>{children as never}</footer>,
}));

import { CodeReviewInstructionsDialog } from "./CodeReviewInstructionsDialog";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const onOpenChange = vi.fn();
const onStart = vi.fn();

async function renderDialog() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <CodeReviewInstructionsDialog open onOpenChange={onOpenChange} onStart={onStart} />,
    ),
  );
}

const textarea = () => container!.querySelector("textarea")!;
const button = (label: string) =>
  [...container!.querySelectorAll("button")].find((element) => element.textContent === label)!;

async function type(value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(textarea(), value);
    textarea().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  onOpenChange.mockReset();
  onStart.mockReset();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("CodeReviewInstructionsDialog (R105)", () => {
  it("starts the review with the typed instructions and closes", async () => {
    await renderDialog();
    expect(container!.querySelector("label")?.textContent).toBe("Instructions for this review");
    await type("Focus on the parser.");
    expect(container!.textContent).toContain("20 / 1,000");
    await act(async () => button("Start review").click());
    expect(onStart).toHaveBeenCalledWith("Focus on the parser.");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("refuses 1,001 characters next to the field and keeps the text", async () => {
    await renderDialog();
    await type("x".repeat(1_001));
    expect(textarea().value).toHaveLength(1_001);
    expect(textarea().getAttribute("aria-invalid")).toBe("true");
    const message = container!.querySelector('[role="alert"]');
    expect(message?.textContent).toBe(
      "Instructions are longer than 1,000 characters. Shorten them to start the review.",
    );
    expect(button("Start review").disabled).toBe(true);
    await act(async () => button("Start review").click());
    expect(onStart).not.toHaveBeenCalled();
    await type("x".repeat(1_000));
    expect(container!.querySelector('[role="alert"]')).toBeNull();
    expect(button("Start review").disabled).toBe(false);
  });

  it("closes without starting on Cancel", async () => {
    await renderDialog();
    await type("Focus on the parser.");
    await act(async () => button("Cancel").click());
    expect(onStart).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
