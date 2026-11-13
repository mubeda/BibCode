// @vitest-environment happy-dom
import type { DesktopBridge, DesktopUpdateState } from "@bibcode/contracts";
import { act, Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({ update: null as DesktopUpdateState | null }));

vi.mock("../env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../env")>()),
  isDesktopHost: true,
}));
vi.mock("../state/desktopUpdate", () => ({ useDesktopUpdateState: () => h.update }));
// The real toast viewport reads the route; no router is mounted here.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useParams: ({ select }: { select?: (params: object) => unknown }) => select?.({}),
}));

import { AppRoot } from "../AppRoot";
import type { AppRouter } from "../router";
import { UnsavedChangesCloseHost } from "./files/UnsavedChangesCloseDialog";
import { RemoteUpdateRequestNotifier } from "./RemoteUpdateRequestNotifier";
import { ToastProvider } from "./ui/toast";

const requestedBy = { label: "Test User", detail: null };
const running = { requestedBy, phase: "installing" };

/** The notifier exactly as `AppRoot` mounts it, with its real Manage devices callback. */
async function appRootNotifier(router: AppRouter): Promise<ReactElement> {
  let tree: ReactElement<{ readonly children: ReactNode }> | null = null;
  // AppRoot is compiled with memo hooks, so it is called inside a render.
  function Capture() {
    tree = AppRoot({ router }) as ReactElement<{ readonly children: ReactNode }>;
    return null;
  }
  await act(async () => root.render(<Capture />));
  const notifier = Children.toArray(tree!.props.children).find(
    (child) => isValidElement(child) && child.type === RemoteUpdateRequestNotifier,
  );
  if (!isValidElement(notifier)) throw new Error("AppRoot does not mount the notifier");
  return notifier;
}

const manageDevices = () =>
  [...document.querySelectorAll<HTMLButtonElement>('[data-slot="toast-action"]')].find(
    (candidate) => candidate.textContent?.trim() === "Manage devices",
  );
const toastText = () => document.querySelector('[data-slot="toast-portal"]')?.textContent ?? "";
const dialogText = () => document.querySelector('[data-slot="alert-dialog-popup"]')?.textContent;

let container: HTMLDivElement;
let root: Root;
let pushState: (state: unknown) => void;
let answer: (state: unknown) => void;

beforeEach(() => {
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.update = { requestedBy, phase: "protecting" } as unknown as DesktopUpdateState;
  window.desktopBridge = {
    onCloseRequest: () => () => {},
    replyCloseRequest: async () => {},
    onUpdateInstallEnded: () => () => {},
    onUpdateState: (listener: (state: unknown) => void) => {
      pushState = listener;
      return () => {};
    },
    getUpdateState: () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  } as unknown as DesktopBridge;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => pushState?.({ requestedBy: null, phase: "idle" }));
  await act(async () => root.unmount());
  delete window.desktopBridge;
  window.sessionStorage.clear();
  document.body.replaceChildren();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
});

describe("Manage devices on the remote-update notice", () => {
  it("cannot leave the person under the installing dialog, and works once the block ends", async () => {
    const navigate = vi.fn(async () => undefined);
    const notifier = await appRootNotifier({ navigate } as unknown as AppRouter);
    const mount = (withNotifier: boolean) =>
      act(async () =>
        root.render(
          <ToastProvider>
            <UnsavedChangesCloseHost />
            {withNotifier ? notifier : null}
          </ToastProvider>,
        ),
      );
    // The toast viewport subscribes first, as in the app, where the notice comes later.
    await mount(false);
    await mount(true);
    await vi.waitFor(() => expect(manageDevices()).toBeDefined(), { timeout: 10_000 });

    await act(async () => answer(running));
    await vi.waitFor(() => expect(dialogText()).toContain("Installing an update"), {
      timeout: 10_000,
    });
    // Settings would open beneath the dialog, where nobody can use it.
    await vi.waitFor(() => expect(manageDevices()!.disabled).toBe(true), { timeout: 10_000 });
    expect(toastText()).toContain("Manage devices is available when the update finishes.");
    await act(async () => {
      manageDevices()!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(navigate).not.toHaveBeenCalled();

    await act(async () => pushState({ requestedBy: null, phase: "failed" }));
    expect(dialogText()).toBeUndefined();
    await vi.waitFor(() => expect(manageDevices()!.disabled).toBe(false), { timeout: 10_000 });
    expect(toastText()).not.toContain("Manage devices is available when the update finishes.");
    await act(async () => {
      manageDevices()!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(navigate).toHaveBeenCalledWith({
      to: "/settings/remote-servers",
      search: { tab: "share" },
    });
  });
});
