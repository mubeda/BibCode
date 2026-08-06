import { describe, expect, it, vi } from "vite-plus/test";

import {
  createDesktopCloseShortcutRouter,
  DESKTOP_CLOSE_SHORTCUT_MENU_ACTION,
} from "./desktopCloseShortcut";

describe("desktop close shortcut router", () => {
  it("leaves native window close requests outside the web shortcut router", async () => {
    const dispatchCloseShortcut = vi.fn(() => true);
    const closeWindow = vi.fn(async () => undefined);
    const router = createDesktopCloseShortcutRouter({ dispatchCloseShortcut, closeWindow });

    await router.handleMenuAction("close-window");

    expect(dispatchCloseShortcut).not.toHaveBeenCalled();
    expect(closeWindow).not.toHaveBeenCalled();
  });

  it("keeps the window open when the web layer consumes the native accelerator", async () => {
    const dispatchCloseShortcut = vi.fn(() => true);
    const closeWindow = vi.fn(async () => undefined);
    const router = createDesktopCloseShortcutRouter({ dispatchCloseShortcut, closeWindow });

    await router.handleMenuAction(DESKTOP_CLOSE_SHORTCUT_MENU_ACTION);

    expect(dispatchCloseShortcut).toHaveBeenCalledOnce();
    expect(closeWindow).not.toHaveBeenCalled();
  });

  it("closes the window when the web layer does not consume the native accelerator", async () => {
    const dispatchCloseShortcut = vi.fn(() => false);
    const closeWindow = vi.fn(async () => undefined);
    const router = createDesktopCloseShortcutRouter({ dispatchCloseShortcut, closeWindow });

    await router.handleMenuAction(DESKTOP_CLOSE_SHORTCUT_MENU_ACTION);

    expect(dispatchCloseShortcut).toHaveBeenCalledOnce();
    expect(closeWindow).toHaveBeenCalledOnce();
  });
});
