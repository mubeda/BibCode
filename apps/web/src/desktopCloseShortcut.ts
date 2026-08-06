import { isMacPlatform } from "./lib/utils";

export const DESKTOP_CLOSE_SHORTCUT_MENU_ACTION = "close-shortcut";

export function createDesktopCloseShortcutRouter(options: {
  readonly dispatchCloseShortcut: () => boolean;
  readonly closeWindow: () => Promise<void>;
}): {
  readonly handleMenuAction: (action: string) => Promise<void>;
} {
  return {
    handleMenuAction: async (action) => {
      if (action !== DESKTOP_CLOSE_SHORTCUT_MENU_ACTION) {
        return;
      }
      if (!options.dispatchCloseShortcut()) {
        await options.closeWindow();
      }
    },
  };
}

function dispatchNativeCloseShortcut(): boolean {
  const mac = isMacPlatform(navigator.platform);
  const event = new KeyboardEvent("keydown", {
    key: "w",
    code: "KeyW",
    metaKey: mac,
    ctrlKey: !mac,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

const desktopCloseShortcutRouter = createDesktopCloseShortcutRouter({
  dispatchCloseShortcut: dispatchNativeCloseShortcut,
  closeWindow: async () => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().close();
  },
});
let installPromise: Promise<() => void> | null = null;

export function installDesktopCloseShortcutRouter(): Promise<() => void> {
  installPromise ??= (async () => {
    const { listen } = await import("@tauri-apps/api/event");
    return listen<string>("desktop:menu-action", (event) => {
      void desktopCloseShortcutRouter.handleMenuAction(event.payload);
    });
  })();
  return installPromise;
}
