import { scopedThreadKey, scopeThreadRef } from "@bibcode/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@bibcode/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Issue #210: the real link path (openLink, openUrlInPreview, the right panel store) with only
// the transport, the native menu and the toast faked.
const mocks = vi.hoisted(() => ({
  openPreview: vi.fn(),
  contextMenuShow: vi.fn(),
  openExternal: vi.fn(),
  toastAdd: vi.fn(),
}));

vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => ({ availableEditors: [] }),
}));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../editorPreferences", () => ({ useOpenInPreferredEditor: () => vi.fn() }));
vi.mock("../state/entities", () => ({ useActiveEnvironmentId: () => "env-1" }));
vi.mock("../state/server", () => ({ serverEnvironment: { configValueAtom: () => ({}) } }));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => mocks.openPreview }));
vi.mock("../state/session", () => ({
  usePreparedConnection: () => Option.some({ httpBaseUrl: "https://server.test/" }),
}));
vi.mock("../localApi", () => ({
  readLocalApi: () => ({
    contextMenu: { show: mocks.contextMenuShow },
    shell: { openExternal: mocks.openExternal },
  }),
}));
vi.mock("./ui/toast", () => ({
  stackedThreadToast: (value: unknown) => value,
  toastManager: { add: mocks.toastAdd },
}));

import { useRightPanelStore } from "../rightPanelStore";
import ChatMarkdown from "./ChatMarkdown";
import { RightPanelThreadContext } from "./chat/rightPanelThread";

const environmentId = "env-1" as EnvironmentId;
const hostRef = scopeThreadRef(environmentId, ThreadId.make("thread-host"));
const panelRef = scopeThreadRef(environmentId, ThreadId.make("thread-panel"));
const url = "https://example.test/docs";

let windowInstance: Window;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  windowInstance = new Window({ url: "https://bibcode.test/" });
  // A desktop host with the internal browser.
  Object.assign(windowInstance, { desktopBridge: { preview: {} } });
  for (const name of [
    "window",
    "document",
    "navigator",
    "localStorage",
    "Node",
    "Element",
    "HTMLElement",
    "Event",
    "MouseEvent",
    "KeyboardEvent",
    "PointerEvent",
    "CustomEvent",
    "DOMParser",
    "MutationObserver",
    "ResizeObserver",
  ] as const) {
    vi.stubGlobal(name, name === "window" ? windowInstance : windowInstance[name]);
  }
  vi.stubGlobal("getComputedStyle", windowInstance.getComputedStyle.bind(windowInstance));
  vi.stubGlobal("requestAnimationFrame", windowInstance.requestAnimationFrame.bind(windowInstance));
  vi.stubGlobal("cancelAnimationFrame", windowInstance.cancelAnimationFrame.bind(windowInstance));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useRightPanelStore.setState({ byThreadKey: {} });
  mocks.openPreview.mockReset().mockImplementation(async ({ input }) =>
    AsyncResult.success({
      threadId: input.threadId,
      tabId: "tab-1",
      navStatus: { _tag: "Loading", url: input.url, title: "" },
      canGoBack: false,
      canGoForward: false,
      updatedAt: "2026-11-02T00:00:00Z",
    }),
  );
  mocks.contextMenuShow.mockReset().mockResolvedValue("open-in-browser");
  mocks.openExternal.mockReset().mockResolvedValue(undefined);
  mocks.toastAdd.mockReset();
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  windowInstance.close();
  vi.unstubAllGlobals();
});

async function mountPanelChatLink(): Promise<HTMLAnchorElement> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <RightPanelThreadContext value={hostRef}>
        <ChatMarkdown text={`[Documentation](${url})`} cwd="/workspace" threadRef={panelRef} />
      </RightPanelThreadContext>,
    ),
  );
  return container.querySelector<HTMLAnchorElement>(`a[href="${url}"]`)!;
}

const flush = () => act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));

describe("a link in a chat panel", () => {
  it("opens in the host's browser panel, the only right panel on screen", async () => {
    const link = await mountPanelChatLink();

    await act(async () =>
      link.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
    );
    await flush();

    expect(mocks.openPreview).toHaveBeenCalledWith({
      environmentId,
      input: { threadId: hostRef.threadId, url: `${url}` },
    });
    const byThreadKey = useRightPanelStore.getState().byThreadKey;
    expect(byThreadKey[scopedThreadKey(hostRef)]).toMatchObject({
      isOpen: true,
      activeSurfaceId: "browser:tab-1",
    });
    expect(byThreadKey[scopedThreadKey(panelRef)]).toBeUndefined();
  });

  it("says when the BiBCode browser can't open it and offers the system browser", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.openPreview.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("rejected"))));
    const link = await mountPanelChatLink();

    await act(async () =>
      link.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
    );
    await flush();

    expect(mocks.toastAdd).toHaveBeenCalledTimes(1);
    const toast = mocks.toastAdd.mock.calls[0]![0] as {
      title: string;
      actionProps: { children: string; onClick: () => void };
    };
    expect(toast.title).toBe("Couldn't open the link in the BiBCode browser");
    expect(toast.actionProps.children).toBe("Open in system browser");
    expect(mocks.openExternal).not.toHaveBeenCalled();

    await act(async () => toast.actionProps.onClick());
    expect(mocks.openExternal).toHaveBeenCalledWith(url);
  });
});
