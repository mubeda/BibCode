// @effect-diagnostics nodeBuiltinImport:off - Inspect the actual native qualification callback through compiled public components without crossing TypeScript project ownership.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import * as NodeVM from "node:vm";
import * as NodeModule from "node:module";
// @vitest-environment happy-dom
import { act, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
const h = vi.hoisted(() => ({
  defaultRoute: false,
  revision: 0,
  listeners: new Set<() => void>(),
  refresh: vi.fn(),
  mint: vi.fn(),
  share: vi.fn(),
  subscribe: (listener: () => void) => {
    h.listeners.add(listener);
    return () => {
      h.listeners.delete(listener);
    };
  },
  snapshot: () => h.revision,
}));
vi.mock("~/environments/primary", () => ({
  cancelServerPairingOffer: vi.fn(),
  createServerPairingOffer: h.mint,
  getServerShareState: h.share,
  PRIMARY_PAIRING_OFFER_REQUEST_TIMEOUT_MS: 50,
  usePrimarySessionState: () => ({
    data: { authenticated: true, auth: { policy: "remote-reachable" } },
  }),
}));
vi.mock("~/state/desktopNetworkAccess", () => ({
  desktopNetworkAccessStateAtom: "network",
  refreshDesktopNetworkAccessState: h.refresh,
}));
vi.mock("~/state/desktopWslState", () => ({ desktopWslStateAtom: "wsl" }));
vi.mock("~/state/environments", () => ({
  usePrimaryEnvironment: () => ({ serverConfig: { environment: { label: "Owned native host" } } }),
  usePrimaryEnvironmentId: () => "primary",
  useEnvironmentHttpBaseUrl: () => "http://127.0.0.1:3773",
}));
vi.mock("~/connection/currentEnvironmentPresentation", () => ({
  readCurrentEnvironmentPresentationPolicy: () => ({ surface: "desktop", platform: "linux" }),
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => {
    useSyncExternalStore(h.subscribe, h.snapshot, h.snapshot);
    return atom === "wsl"
      ? { data: { wslOnly: false }, error: null, isPending: false }
      : {
          data: {
            serverExposureState: {
              configuredMode: "local-only",
              management: "native",
              mode: "local-only",
              endpointUrl: null,
              advertisedHost: null,
              tailscaleServeEnabled: false,
              tailscaleServePort: 443,
            },
            advertisedEndpoints: [
              {
                id: "owned-lan",
                label: "Local network",
                provider: { id: "desktop-core", label: "Desktop", kind: "core", isAddon: false },
                httpBaseUrl: "http://10.254.231.1:3773",
                wsBaseUrl: "ws://10.254.231.1:3773",
                reachability: "lan",
                compatibility: {
                  hostedHttpsApp: "mixed-content-blocked",
                  desktopApp: "compatible",
                },
                source: "desktop-core",
                status: "unavailable",
                isDefault: h.defaultRoute,
              },
            ],
          },
          error: null,
          isPending: false,
        };
  },
}));
vi.mock("./components/settings/remote-servers/ShareTab", () => ({
  ShareTab: () => <section>Owned paired-client area</section>,
}));
import { ShareThisHostTab } from "./components/settings/remote-servers/ShareThisHostTab";
import { Tabs, TabsList, TabsTab, TabsPanel } from "./components/ui/tabs";
const nativeDomSource = NodeFS.readFileSync(
  new NodeURL.URL(
    "../../desktop/e2e/support/release-visual-native-sharing-dom.ts",
    import.meta.url,
  ),
  "utf8",
);
const nativeDomStart = nativeDomSource.indexOf("export function readNativeSharingDom");
const nativeDomEnd = nativeDomSource.indexOf(
  "export function validateNativeSharingDom",
  nativeDomStart,
);
const readNativeSharingDom = (input: { scene: string; theme: string; origin: string }) => {
  const reader = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(
      nativeDomSource.slice(nativeDomStart, nativeDomEnd).replace("export function", "function"),
    ) + "\nreadNativeSharingDom",
    {
      document,
      location,
      URL: NodeURL.URL,
      getComputedStyle,
      innerWidth,
      innerHeight,
      HTMLButtonElement,
      HTMLSelectElement,
      Number,
    },
  );
  return reader(input);
};
const validateNativeSharingDom = (value: unknown) => {
  expect(value).not.toBeNull();
  expect(Object.values(value as object).every((flag) => flag === true)).toBe(true);
  return value;
};
let root: ReturnType<typeof createRoot> | undefined;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  h.defaultRoute = false;
  h.revision = 0;
  h.listeners.clear();
  h.refresh.mockReset().mockImplementation(() => {
    h.defaultRoute = true;
    h.revision++;
    for (const listener of h.listeners) listener();
  });
  h.mint.mockReset();
  h.share
    .mockReset()
    .mockResolvedValue({ desiredExposure: "loopback", offHostGrantCount: 0, legacyGrantCount: 0 });
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { getServerExposureState: async () => ({ mode: "local-only" }) },
  });
  vi.stubGlobal("location", {
    origin: "null",
    href: "tauri://localhost/#/settings/remote-servers",
    pathname: "/",
    search: "",
    hash: "#/settings/remote-servers",
  });
  vi.stubGlobal("innerWidth", 1280);
  vi.stubGlobal("innerHeight", 960);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    x: 10,
    y: 10,
    left: 10,
    top: 10,
    right: 1000,
    bottom: 900,
    width: 990,
    height: 890,
    toJSON: () => ({}),
  });
  vi.spyOn(document, "elementFromPoint").mockImplementation(() =>
    document.querySelector('[role="tabpanel"]'),
  );
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  document.body.innerHTML = "";
  delete window.desktopBridge;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it.each(["light", "dark"] as const)(
  "the actual compiled sharing control refreshes missing-route state without minting an offer: %s",
  async (theme) => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        <Tabs defaultValue="share">
          <TabsList>
            <TabsTab value="share">Share this host</TabsTab>
          </TabsList>
          <TabsPanel value="share">
            <ShareThisHostTab />
          </TabsPanel>
        </Tabs>,
      ),
    );
    expect(
      validateNativeSharingDom(
        readNativeSharingDom({
          scene: "native-share-no-route",
          theme,
          origin: "tauri://localhost",
        }),
      ),
    ).toEqual(expect.objectContaining({ expectedState: true }));
    const refresh = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Refresh addresses"]',
    )!;
    await act(async () => refresh.click());
    expect(h.refresh).toHaveBeenCalledOnce();
    expect(h.mint).not.toHaveBeenCalled();
    expect(
      validateNativeSharingDom(
        readNativeSharingDom({
          scene: "native-share-refresh",
          theme,
          origin: "tauri://localhost",
        }),
      ),
    ).toEqual(expect.objectContaining({ expectedState: true }));
  },
);
