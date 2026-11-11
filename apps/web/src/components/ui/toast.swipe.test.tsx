// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The sibling toast.test.tsx mocks Base UI wholesale; this file needs the real swipe-to-dismiss.
vi.mock("@tanstack/react-router", () => ({ useParams: () => null }));

import { ToastProvider, toastManager } from "./toast";

let root: Root | null = null;
let host: HTMLElement | null = null;

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 20))));

function pointer(type: string, target: Element | Document, x: number, y: number) {
  const event = new PointerEvent(type, {
    bubbles: true,
    button: 0,
    clientX: x,
    clientY: y,
    pointerId: 1,
    pointerType: "touch",
  });
  act(() => void target.dispatchEvent(event));
}

/** A touch drag to the right: far past Base UI's dismiss threshold on a top-right toast. */
function swipeRight(from: Element) {
  pointer("pointerdown", from, 10, 10);
  pointer("pointermove", from, 12, 10);
  pointer("pointermove", from, 120, 10);
  pointer("pointerup", document, 120, 10);
}

async function showToast(id: string) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<ToastProvider position="top-right">{null}</ToastProvider>));
  await act(async () => {
    toastManager.add({
      id,
      title: "Build failed",
      description: "first line\nsecond line",
      type: "error",
      timeout: 0,
    });
  });
  await settle();
}

describe("multi-line toast swipe handling", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(async () => {
    await act(async () => root?.unmount());
    host?.remove();
    root = host = null;
    document.body.replaceChildren();
  });

  it("dismisses on a swipe that starts on the title (control)", async () => {
    await showToast("swipe-control");
    const title = document.querySelector('[data-slot="toast-title"]')!;
    expect(title).not.toBeNull();
    swipeRight(title);
    await settle();
    expect(document.querySelector('[data-slot="toast-title"]')).toBeNull();
  });

  it("keeps the toast open when the drag starts inside the scrollable details", async () => {
    await showToast("swipe-details");
    const details = document.querySelector('[role="group"]')!;
    expect(details).not.toBeNull();
    swipeRight(details);
    await settle();
    expect(document.querySelector('[data-slot="toast-title"]')).not.toBeNull();
  });
});
