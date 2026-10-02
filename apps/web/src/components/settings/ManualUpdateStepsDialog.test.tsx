// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
vi.mock("../ui/dialog", () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: Box,
    DialogPopup: Box,
    DialogHeader: Box,
    DialogTitle: Box,
    DialogDescription: Box,
    DialogPanel: Box,
    DialogFooter: Box,
  };
});
vi.mock("../ui/toast", () => ({
  toastManager: { add: vi.fn() },
  stackedThreadToast: (input: unknown) => input,
}));
import { ManualUpdateStepsDialog } from "./ManualUpdateStepsDialog";
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
describe("ManualUpdateStepsDialog", () => {
  it("names the host, copies its steps, and closes without running any command", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const close = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () =>
      root.render(
        <ManualUpdateStepsDialog
          request={{ name: "Build server", steps: "# Stop this server\nbibcode serve" }}
          onClose={close}
        />,
      ),
    );
    expect(container.textContent).toContain("Update Build server manually");
    const steps = container.querySelector("pre");
    expect(steps?.dataset.textSurface).toBe("card");
    expect(steps?.classList.contains("bg-card")).toBe(true);
    expect(steps?.parentElement?.classList.contains("overflow-x-auto")).toBe(true);
    expect(steps?.parentElement?.closest('[data-text-surface="background"]')).not.toBeNull();
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Copy")!
        .click(),
    );
    expect(copy).toHaveBeenCalledExactlyOnceWith("# Stop this server\nbibcode serve");
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Close")!
        .click(),
    );
    expect(close).toHaveBeenCalledOnce();
  });
});
