import { EnvironmentId, ThreadId } from "@bibcode/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  finishResolve: (_value: unknown) => undefined as void,
  resolveCalls: [] as unknown[],
  navigateCalls: [] as string[],
  releasedTabs: [] as string[],
  reports: [] as unknown[],
  notices: [] as unknown[],
  previewState: { sessions: {}, desktopByTabId: {} } as Record<string, unknown>,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void)) => {
      h.effects.push(effect);
    },
  };
});
vi.mock("~/components/preview/usePreviewBridge", () => ({ usePreviewBridge: () => undefined }));
vi.mock("~/previewStateStore", () => ({ readThreadPreviewState: () => h.previewState }));
vi.mock("~/state/preview", () => ({
  previewEnvironment: { gatewayOpen: { label: "gatewayOpen" }, reportStatus: { label: "report" } },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: { label: string }) => (input: unknown) => {
    if (command.label === "report") h.reports.push(input);
    return Promise.resolve(undefined);
  },
}));
vi.mock("./linkNotices", () => ({
  showPreviewUnreachableMessage: (...args: unknown[]) => h.notices.push(args),
}));
vi.mock("./desktopTabLifetime", () => ({
  acquireDesktopTab: () => ({
    navigate: async (url: string, shouldNavigate: () => boolean) => {
      if (shouldNavigate()) h.navigateCalls.push(url);
    },
    release: () => undefined,
  }),
}));
vi.mock("./previewGateway", () => ({
  resolveForNavigation: (input: unknown) => {
    h.resolveCalls.push(input);
    return new Promise((resolve) => (h.finishResolve = resolve));
  },
  releasePreviewTab: (_environmentId: unknown, tabId: string) => h.releasedTabs.push(tabId),
}));

import { NativePreviewTabHost } from "./DesktopPreviewTabHosts";

const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};
const initialUrl = "http://localhost:5173/";
const gatewayUrl = "http://127.0.0.1:50000/__bibcode/bootstrap?cap=C&to=%2F";

function mount(): () => void {
  renderToStaticMarkup(
    <NativePreviewTabHost threadRef={threadRef} tabId="tab-1" initialUrl={initialUrl} />,
  );
  const cleanup = h.effects.at(-1)!();
  return typeof cleanup === "function" ? cleanup : () => undefined;
}

const flush = async () => {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
};

beforeEach(() => {
  h.effects.length = 0;
  h.resolveCalls.length = 0;
  h.navigateCalls.length = 0;
  h.releasedTabs.length = 0;
  h.reports.length = 0;
  h.notices.length = 0;
  h.previewState = {
    sessions: { "tab-1": { navStatus: { _tag: "Success", url: initialUrl, title: "" } } },
    desktopByTabId: {},
  };
});

describe("NativePreviewTabHost", () => {
  it("resolves the canonical initial URL for this client before navigating", async () => {
    mount();
    expect(h.resolveCalls).toMatchObject([{ canonicalUrl: initialUrl, tabId: "tab-1" }]);
    h.finishResolve({ kind: "ok", url: gatewayUrl });
    await flush();
    expect(h.navigateCalls).toEqual([gatewayUrl]);
  });

  it("does not drag the tab back when it moved on while resolving", async () => {
    mount();
    h.previewState = {
      sessions: {
        "tab-1": { navStatus: { _tag: "Loading", url: "http://localhost:3000/", title: "" } },
      },
      desktopByTabId: {},
    };
    h.finishResolve({ kind: "ok", url: gatewayUrl });
    await flush();
    expect(h.navigateCalls).toEqual([]);
  });

  it("fails a refused initial URL with its reason and releases forwards on unmount", async () => {
    const cleanup = mount();
    h.finishResolve({
      kind: "unreachable",
      message: "Nothing is listening.",
      refusedByServer: true,
    });
    await flush();
    expect(h.navigateCalls).toEqual([]);
    expect(h.notices).toEqual([]);
    expect(h.reports).toEqual([
      {
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          tabId: "tab-1",
          canGoBack: false,
          canGoForward: false,
          navStatus: {
            _tag: "LoadFailed",
            url: initialUrl,
            title: "",
            code: 0,
            description: "Nothing is listening",
          },
        },
      },
    ]);
    cleanup();
    expect(h.releasedTabs).toEqual(["tab-1"]);
  });

  it("keeps a failure on this client's side out of shared state", async () => {
    mount();
    h.finishResolve({ kind: "unreachable", message: "Build box isn't connected." });
    await flush();
    expect(h.reports).toEqual([]);
    expect(h.notices).toEqual([["Build box isn't connected.", initialUrl]]);
  });
});
