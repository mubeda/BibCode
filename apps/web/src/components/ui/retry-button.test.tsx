// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { RetryButton, type RetryButtonProps } from "./retry-button";

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
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

async function renderButton(props: RetryButtonProps): Promise<HTMLButtonElement> {
  await act(async () => root.render(<RetryButton {...props} />));
  const button = container.querySelector("button");
  if (button === null) throw new Error("RetryButton rendered no button.");
  return button;
}

describe("RetryButton", () => {
  it("retries a failed load on click", async () => {
    const onRetry = vi.fn();
    const button = await renderButton({ retrying: false, onRetry });
    expect(button.textContent).toBe("Retry");
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("says a read is running and accepts no second Retry meanwhile", async () => {
    const onRetry = vi.fn();
    const button = await renderButton({ retrying: true, onRetry });
    expect(button.textContent).toBe("Retrying…");
    expect(button.disabled).toBe(true);
    await act(async () => button.click());
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("says it waits for the connection while the environment is disconnected", async () => {
    for (const retrying of [false, true]) {
      const button = await renderButton({ retrying, waitingForConnection: true, onRetry: vi.fn() });
      expect(button.textContent).toBe("Waiting for the connection…");
      expect(button.disabled).toBe(true);
    }
  });
});
