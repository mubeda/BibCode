// @vitest-environment happy-dom
// @effect-diagnostics nodeBuiltinImport:off - Execute the actual QA segment against real mounted UI without network.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import { RegistryContext } from "@effect/atom-react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useLocation,
} from "@tanstack/react-router";
import { EnvironmentId, type SourceControlDiscoveryResult } from "@bibcode/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@bibcode/contracts/settings";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const ports = vi.hoisted(() => ({
  discovery: null as unknown,
  targets: [] as unknown[],
  updateSettings: vi.fn(),
}));
// External environment/query/command ports supply real atoms; hooks and UI remain real.
vi.mock("../../state/sourceControl", () => ({
  sourceControlEnvironment: {
    discovery: (target: unknown) => {
      ports.targets.push(target);
      return ports.discovery;
    },
  },
}));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironment: () => ({ environmentId: "owned-source-control" }),
}));
vi.mock("../../state/server", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  const { DEFAULT_SERVER_SETTINGS } = await import("@bibcode/contracts");
  return {
    primaryServerSettingsAtom: Atom.make(DEFAULT_SERVER_SETTINGS),
    serverEnvironment: {
      updateSettings: { label: "owned settings update", run: ports.updateSettings },
    },
  };
});
vi.mock("~/connection/currentEnvironmentPresentation", async () => {
  const { createEnvironmentPresentationPolicy } =
    await import("~/connection/environmentPresentationPolicy");
  return {
    readCurrentEnvironmentPresentationPolicy: () =>
      createEnvironmentPresentationPolicy({ surface: "desktop", platform: "linux" }),
  };
});

import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
} from "../../hooks/useSettings";
import { Sidebar, SidebarInset, SidebarProvider } from "../ui/sidebar";
import { SettingsSidebarNav } from "./SettingsSidebarNav";
import { SourceControlSettingsPanel } from "./SourceControlSettings";

const discovery: SourceControlDiscoveryResult = {
  versionControlSystems: [
    {
      kind: "git",
      label: "Git",
      executable: "git",
      implemented: true,
      status: "available",
      version: Option.some("git version 2.50.0"),
      installHint: "Install Git.",
      detail: Option.none(),
    },
  ],
  sourceControlProviders: [],
};

function MountedSettings() {
  const location = useLocation();
  return (
    <SidebarProvider>
      <Sidebar>
        <SettingsSidebarNav pathname={location.pathname} />
      </Sidebar>
      <SidebarInset>
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  );
}

it("uses the existing displayed wait before counting the cold mounted Git details control", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  ports.targets.length = 0;
  ports.updateSettings.mockReset();
  const query = Atom.make<AsyncResult.AsyncResult<SourceControlDiscoveryResult, Error>>(
    AsyncResult.initial(true),
  );
  ports.discovery = query;
  const registry = AtomRegistry.make();
  const rootRoute = createRootRoute({ component: MountedSettings });
  const initialRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/keybindings",
    component: () => null,
  });
  const sourceControlRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/source-control",
    component: SourceControlSettingsPanel,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([initialRoute, sourceControlRoute]),
    history: createMemoryHistory({ initialEntries: ["/settings/keybindings"] }),
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const network = vi.fn(() => {
    throw new Error("No network in mounted Source Control seam.");
  });
  vi.stubGlobal("fetch", network);
  vi.stubGlobal("localStorage", window.localStorage);
  const calls: string[] = [];
  const details = 'button[aria-label="Toggle Git details"]';
  const matches = (selector: string) =>
    selector === "button=Source Control"
      ? Array.from(document.querySelectorAll<HTMLButtonElement>("button")).filter(
          (button) => button.textContent?.trim() === "Source Control",
        )
      : Array.from(document.querySelectorAll<HTMLButtonElement>(selector));
  const control = (selector: string) => (selector === details ? "details" : "nav");
  let captures = 0;
  try {
    await act(async () => {
      await router.load();
      root.render(
        <RegistryContext.Provider value={registry}>
          <RouterProvider router={router} />
        </RegistryContext.Provider>,
      );
    });
    const source = NodeFS.readFileSync(
      new NodeURL.URL(
        "../../../../desktop/e2e/support/release-visual-settings.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const start = source.indexOf(
      "  const { browser, step } = input;",
      source.indexOf("export async function runVisualSettings"),
    );
    const end = source.indexOf("  const unchanged = async", start);
    const bodyStart = source.indexOf('    step("visual-settings-source-control-open");', end);
    const bodyEnd = source.indexOf('    await click("button=Providers");', bodyStart);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(bodyStart).toBeGreaterThan(end);
    expect(bodyEnd).toBeGreaterThan(bodyStart);
    const run = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(
        "async function replay(input, capture) {\n" +
          source.slice(start, end) +
          source.slice(bodyStart, bodyEnd) +
          "\n}\nreplay",
      ),
    ) as (input: unknown, capture: (scene: string) => Promise<void>) => Promise<void>;
    await expect(
      run(
        {
          step: () => {},
          browser: {
            $$: async (selector: string) => {
              calls.push(control(selector) + "-count");
              return matches(selector);
            },
            $: (selector: string) => ({
              waitForDisplayed: async () => {
                calls.push(control(selector) + "-displayed");
                if (selector === details) {
                  expect(registry.get(query)._tag).toBe("Initial");
                  expect(matches(details)).toHaveLength(0);
                  expect(
                    document.querySelectorAll('[data-slot="skeleton"]').length,
                  ).toBeGreaterThan(0);
                  await act(async () => registry.set(query, AsyncResult.success(discovery)));
                }
                expect(matches(selector)).toHaveLength(1);
              },
              waitForEnabled: async () => {
                calls.push(control(selector) + "-enabled");
                expect(matches(selector)[0]!.disabled).toBe(false);
              },
              click: async () => {
                calls.push(control(selector) + "-click");
                await act(async () => matches(selector)[0]!.click());
              },
            }),
          },
        },
        async (scene) => {
          expect(scene).toBe("settings-source-control");
          expect(matches(details)[0]!.getAttribute("aria-expanded")).toBe("true");
          expect(
            document.querySelector<HTMLInputElement>(
              'input[aria-label="Automatic Git fetch interval in seconds"]',
            )?.value,
          ).toBe("180");
          captures++;
        },
      ),
    ).resolves.toBeUndefined();
    expect(calls).toEqual([
      "nav-displayed",
      "nav-count",
      "nav-enabled",
      "nav-click",
      "details-displayed",
      "details-count",
      "details-enabled",
      "details-click",
    ]);
    expect(captures).toBe(1);
    expect(ports.targets.length).toBeGreaterThan(0);
    expect(
      ports.targets.every(
        (target) =>
          JSON.stringify(target) ===
          JSON.stringify({
            environmentId: EnvironmentId.make("owned-source-control"),
            input: { recordHosts: true },
          }),
      ),
    ).toBe(true);
    expect(ports.updateSettings).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    registry.dispose();
    __resetClientSettingsPersistenceForTests();
    vi.unstubAllGlobals();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  }
}, 5_000);
