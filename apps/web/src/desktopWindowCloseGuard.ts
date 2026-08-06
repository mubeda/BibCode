import { isMacPlatform } from "./lib/utils";

type DesktopCloseRequest = {
  readonly preventDefault: () => void;
};

type DesktopCloseRequestListener = (event: DesktopCloseRequest) => void;
type SubscribeToDesktopCloseRequests = (
  listener: DesktopCloseRequestListener,
) => Promise<() => void>;

export function createDesktopWindowCloseGuard(options: {
  readonly dispatchCloseShortcut: () => boolean;
}): {
  readonly install: (subscribe: SubscribeToDesktopCloseRequests) => Promise<() => void>;
} {
  return {
    install: (subscribe) =>
      subscribe((event) => {
        if (options.dispatchCloseShortcut()) {
          event.preventDefault();
        }
      }),
  };
}

function dispatchNativeWindowCloseShortcut(): boolean {
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

const desktopWindowCloseGuard = createDesktopWindowCloseGuard({
  dispatchCloseShortcut: dispatchNativeWindowCloseShortcut,
});
let installPromise: Promise<() => void> | null = null;

export function installDesktopWindowCloseGuard(): Promise<() => void> {
  installPromise ??= desktopWindowCloseGuard.install(async (listener) => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return getCurrentWindow().onCloseRequested(listener);
  });
  return installPromise;
}
