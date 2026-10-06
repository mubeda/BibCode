// @effect-diagnostics nodeBuiltinImport:off - Execute the native qualification reader against compiled public components through a hermetic VM.
// @vitest-environment happy-dom
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import * as NodeURL from "node:url";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { DesktopUpdateState } from "@bibcode/contracts";
import { UpdateProtectionDialog } from "./components/desktop/UpdateProtectionDialog";
import { BrowserDeviceToolbar } from "./browser/BrowserDeviceToolbar";
import { createTauriPreviewBridge } from "./tauriPreviewBridge";
import { supportsPreviewRuntimeCapability } from "./previewRuntimeCapabilities";
vi.mock("@tanstack/react-router", async (load) => ({
  ...(await load<typeof import("@tanstack/react-router")>()),
  Link: ({ children, to }: { children?: import("react").ReactNode; to?: string }) => (
    <a href={to}>{children}</a>
  ),
}));
const wsl = vi.hoisted(() => ({ available: true }));
vi.mock("~/state/environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
vi.mock("~/state/desktopWslState", () => ({
  desktopWslStateAtom: "wsl",
  refreshDesktopWslState: () => {},
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: {
      available: wsl.available,
      enabled: true,
      wslOnly: true,
      distro: "OwnedDistro",
      distros: [{ name: "OwnedDistro", isDefault: true, version: 2 }],
      preflightError: null,
    },
    isPending: false,
    error: null,
  }),
}));
import { LocalEnvironmentSettings } from "./components/settings/LocalEnvironmentSettings";

const source = NodeFS.readFileSync(
  new NodeURL.URL(
    "../../desktop/e2e/support/release-visual-native-followups-dom.ts",
    import.meta.url,
  ),
  "utf8",
);
const reader = () =>
  NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(
      source.slice(source.indexOf("export function")).replace("export function", "function"),
    ) + "\nreadNativeFollowupDom",
    { document, location, localStorage, getComputedStyle },
  );
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("localStorage", window.localStorage);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    width: 300,
    height: 40,
    bottom: 40,
    right: 300,
    toJSON: () => ({}),
  }));
  root = createRoot(document.body.appendChild(document.createElement("div")));
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete window.desktopBridge;
});
const base: DesktopUpdateState = {
  enabled: true,
  status: "downloaded",
  currentVersion: "0.8.0",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: "0.8.1-upgrade.1",
  downloadedVersion: "0.8.1-upgrade.1",
  downloadPercent: 100,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
  phase: "available",
  protection: [],
  backendRecovery: [],
};
it("qualifies the actual first protection dialog and rejects an unsafe failure-state substitution", async () => {
  await act(async () =>
    root.render(
      <UpdateProtectionDialog
        open
        state={base}
        onOpenChange={() => {}}
        installUpdate={async () => {
          throw new Error("not invoked");
        }}
        onDiagnostics={() => {}}
      />,
    ),
  );
  const read = reader();
  expect(
    read({
      scene: "native-update-protection",
      theme: "light",
      privateRoots: [],
      draft: "",
      distro: null,
    }),
  ).toMatchObject({
    publicEntryMatched: true,
    protectionDefault: true,
    cancelAvailable: true,
    unsafeBypassAbsent: true,
  });
  await act(async () =>
    root.render(
      <UpdateProtectionDialog
        open
        state={{
          ...base,
          phase: "failed",
          protection: [
            {
              environmentId: "primary",
              label: "Owned local",
              status: "failed",
              message: "Owned failure",
            },
          ],
        }}
        onOpenChange={() => {}}
        installUpdate={async () => {
          throw new Error("not invoked");
        }}
        onDiagnostics={() => {}}
      />,
    ),
  );
  expect(
    read({
      scene: "native-update-protection",
      theme: "light",
      privateRoots: [],
      draft: "",
      distro: null,
    }).unsafeBypassAbsent,
  ).toBe(false);
});
it("qualifies the real recovery dialog's native restart action and disabled retry explanation", async () => {
  await act(async () =>
    root.render(
      <UpdateProtectionDialog
        open
        state={{
          ...base,
          status: "error",
          phase: "failed",
          errorContext: "install",
          backendRecovery: [
            { environmentId: "primary", label: "Owned local", reason: "port-in-use", port: 4883 },
          ],
        }}
        onOpenChange={() => {}}
        installUpdate={async () => {
          throw new Error("not invoked");
        }}
        onDiagnostics={() => {}}
      />,
    ),
  );
  expect(
    reader()({
      scene: "native-update-recovery",
      theme: "light",
      privateRoots: [],
      draft: "",
      distro: null,
    }),
  ).toMatchObject({ publicEntryMatched: true, restartActionAvailable: true, retryExplained: true });
});
it("retains the real device toolbar while reporting the current Tauri picker as unsupported", async () => {
  const bridge = createTauriPreviewBridge({
    invoke: async () => {
      throw new Error("native invocation forbidden in this seam test");
    },
    listen: () => () => {},
  });
  await act(async () =>
    root.render(
      <BrowserDeviceToolbar
        setting={{ _tag: "freeform", width: 800, height: 600 }}
        width={640}
        aspectRatio={null}
        onAspectRatioChange={() => {}}
        onChange={async () => {}}
      />,
    ),
  );
  expect(document.querySelector('[aria-label="Browser device toolbar"]')).not.toBeNull();
  expect(supportsPreviewRuntimeCapability(bridge, "picker")).toBe(false);
  expect(supportsPreviewRuntimeCapability(bridge, "automation")).toBe(false);
  await expect(bridge.pickElement("owned-tab")).rejects.toMatchObject({
    capability: "preview.pickElement",
  });
  expect(
    reader()({
      scene: "native-preview-annotations",
      theme: "light",
      privateRoots: [],
      draft: "",
      distro: null,
    }),
  ).toMatchObject({
    publicEntryMatched: false,
    deviceToolbar: true,
    publicPicker: false,
    annotationCard: false,
  });
});
it("reads the compiled mapped-WSL controls and rejects the real unavailable presentation", async () => {
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: {
      setWslDistro: async () => {},
      setWslBackendEnabled: async () => {},
      setWslOnly: async () => {},
    },
  });
  location.hash = "#/settings/local-environment";
  wsl.available = true;
  await act(async () => root.render(<LocalEnvironmentSettings />));
  expect(
    reader()({
      scene: "native-wsl-local",
      theme: "light",
      privateRoots: [],
      draft: "",
      distro: "OwnedDistro",
    }),
  ).toMatchObject({ publicEntryMatched: true, localSettings: true });
  wsl.available = false;
  await act(async () => root.render(<LocalEnvironmentSettings />));
  expect(
    reader()({
      scene: "native-wsl-local",
      theme: "light",
      privateRoots: [],
      draft: "",
      distro: "OwnedDistro",
    }).localSettings,
  ).toBe(false);
});
