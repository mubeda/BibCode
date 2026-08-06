import { describe, expect, it, vi } from "vite-plus/test";

import { createDesktopWindowCloseGuard } from "./desktopWindowCloseGuard";

describe("desktop window close guard", () => {
  it("consumes a native close request when the center-terminal shortcut handles it", async () => {
    let onCloseRequested: ((event: { preventDefault(): void }) => void) | undefined;
    const preventDefault = vi.fn();
    const dispatchCloseShortcut = vi.fn(() => true);
    const guard = createDesktopWindowCloseGuard({ dispatchCloseShortcut });

    await guard.install(async (listener) => {
      onCloseRequested = listener;
      return () => undefined;
    });
    onCloseRequested?.({ preventDefault });

    expect(dispatchCloseShortcut).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("preserves native window close requests outside terminal shortcuts", async () => {
    let onCloseRequested: ((event: { preventDefault(): void }) => void) | undefined;
    const preventDefault = vi.fn();
    const dispatchCloseShortcut = vi.fn(() => false);
    const guard = createDesktopWindowCloseGuard({ dispatchCloseShortcut });

    await guard.install(async (listener) => {
      onCloseRequested = listener;
      return () => undefined;
    });
    onCloseRequested?.({ preventDefault });

    expect(dispatchCloseShortcut).toHaveBeenCalledOnce();
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
