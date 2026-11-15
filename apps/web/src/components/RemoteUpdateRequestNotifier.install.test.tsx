// @vitest-environment happy-dom
import type { DesktopBridge } from "@bibcode/contracts";
import { act, Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../env")>()),
  isDesktopHost: true,
}));
// The real toast viewport reads the route; no router is mounted here.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useParams: ({ select }: { select?: (params: object) => unknown }) => select?.({}),
}));

import type { AppRouter } from "../router";

const MARKER = "bibcode:update-install-allowed";
const REASON = "Manage devices is available when the update finishes.";
const requestedBy = { label: "Test User", detail: null };
const running = { requestedBy, phase: "installing" };
const idle = { requestedBy: null, phase: "idle" };
const completedLook = { requestedBy: null, phase: "installing" };

type Listener = (state: unknown) => void;
type Query = { resolve: (state: unknown) => void; reject: (error: unknown) => void };

/** One desktop: the close host subscribes first, the real update-state atom second. */
function fakeDesktop() {
  const desktop = {
    listeners: [] as Listener[],
    queries: [] as Query[],
    ended: null as (() => void) | null,
    bridge: {
      onCloseRequest: () => () => {},
      replyCloseRequest: async () => {},
      onUpdateInstallEnded: (listener: () => void) => {
        desktop.ended = listener;
        return () => {};
      },
      onUpdateState: (listener: Listener) => {
        desktop.listeners.push(listener);
        return () => {};
      },
      getUpdateState: () =>
        new Promise((resolve, reject) => {
          desktop.queries.push({ resolve, reject });
        }),
    } as unknown as DesktopBridge,
    toHost: (state: unknown) => act(async () => desktop.listeners[0]!(state)),
    toAtom: (state: unknown) => act(async () => desktop.listeners[1]!(state)),
  };
  return desktop;
}

const manageDevices = () =>
  [...document.querySelectorAll<HTMLButtonElement>('[data-slot="toast-action"]')].find(
    (candidate) => candidate.textContent?.trim() === "Manage devices",
  );
const toastText = () => document.querySelector('[data-slot="toast-portal"]')?.textContent ?? "";
const dialogText = () => document.querySelector('[data-slot="alert-dialog-popup"]')?.textContent;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  delete window.desktopBridge;
  window.sessionStorage.clear();
  document.body.replaceChildren();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
  vi.restoreAllMocks();
});

/**
 * A window reloaded during an allowed install, with the notice up, then the end of the install.
 * Fresh modules per run: the update-state atom and the install block live in module state.
 */
async function installWindow() {
  vi.resetModules();
  const { AppRoot } = await import("../AppRoot");
  const { UnsavedChangesCloseHost } = await import("./files/UnsavedChangesCloseDialog");
  const { RemoteUpdateRequestNotifier } = await import("./RemoteUpdateRequestNotifier");
  const { ToastProvider } = await import("./ui/toast");
  const desktop = fakeDesktop();
  window.desktopBridge = desktop.bridge;
  window.sessionStorage.setItem(MARKER, "1");
  const navigate = vi.fn(async () => undefined);

  // The notifier exactly as `AppRoot` mounts it, with its real Manage devices callback.
  let tree: ReactElement<{ readonly children: ReactNode }> | null = null;
  function Capture() {
    tree = AppRoot({ router: { navigate } as unknown as AppRouter }) as typeof tree;
    return null;
  }
  await act(async () => root.render(<Capture />));
  const notifier = Children.toArray(tree!.props.children).find(
    (child) => isValidElement(child) && child.type === RemoteUpdateRequestNotifier,
  );
  if (!isValidElement(notifier)) throw new Error("AppRoot does not mount the notifier");

  const mount = (withNotifier: boolean) =>
    act(async () =>
      root.render(
        <ToastProvider>
          <UnsavedChangesCloseHost />
          {withNotifier ? notifier : null}
        </ToastProvider>,
      ),
    );
  // The toast viewport and the close host subscribe first, as in the app.
  await mount(false);
  await mount(true);
  // queries[0] is the close host's, queries[1] the atom's first read.
  await vi.waitFor(() => expect(desktop.queries).toHaveLength(2), { timeout: 10_000 });
  await act(async () => desktop.queries[1]!.resolve(running));
  await vi.waitFor(() => expect(manageDevices()?.disabled).toBe(true), { timeout: 10_000 });
  expect(dialogText()).toContain("Installing an update");
  expect(toastText()).toContain(REASON);
  return { desktop, navigate };
}

type Desktop = ReturnType<typeof fakeDesktop>;
const endings: Record<string, (desktop: Desktop) => Promise<void>> = {
  "the ended event": async (desktop) => {
    await act(async () => desktop.ended!());
  },
  "a pushed state": async (desktop) => {
    await desktop.toHost(idle);
  },
  "a confirmed query answer": async (desktop) => {
    await act(async () => desktop.queries[0]!.resolve(idle));
  },
  "Check again": async (desktop) => {
    await act(async () => desktop.queries[0]!.resolve(running));
    const check = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === "Check again",
    )!;
    await act(async () => check.click());
    await act(async () => desktop.queries.at(-1)!.resolve(idle));
  },
};

describe("Manage devices on the remote-update notice", () => {
  for (const [ending, end] of Object.entries(endings)) {
    for (const order of ["requester clears first", "block ends first"] as const) {
      it(`ends enabled when ${order}, through ${ending}`, async () => {
        const { desktop, navigate } = await installWindow();
        // Settings would open beneath the dialog, where nobody can use it.
        await act(async () => {
          manageDevices()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(navigate).not.toHaveBeenCalled();

        // A completed install clears the requester while the phase stays "installing".
        if (order === "requester clears first") await desktop.toAtom(completedLook);
        await end(desktop);
        if (order === "block ends first") await desktop.toAtom(idle);

        expect(dialogText()).toBeUndefined();
        await vi.waitFor(() => expect(manageDevices()?.disabled).toBe(false), {
          timeout: 10_000,
        });
        expect(toastText()).not.toContain(REASON);
        await act(async () => {
          manageDevices()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(navigate).toHaveBeenCalledWith({
          to: "/settings/remote-servers",
          search: { tab: "share" },
        });
      }, 30_000);
    }
  }
});
