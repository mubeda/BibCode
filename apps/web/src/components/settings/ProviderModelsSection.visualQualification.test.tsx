// @vitest-environment happy-dom
// @effect-diagnostics nodeBuiltinImport:off - Real mounted settings card and serialized read-only QA source; no network.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import * as NodeURL from "node:url";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@bibcode/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { Route as SettingsRoute } from "../../routes/settings";
import { Sidebar, SidebarProvider } from "../ui/sidebar";
import { SettingsSidebarNav } from "./SettingsSidebarNav";
import { SettingsPageContainer } from "./settingsLayout";
import { ProviderInstanceCard } from "./ProviderInstanceCard";
import { DRIVER_OPTION_BY_VALUE } from "./providerDriverMeta";

it.each([false, true])(
  "reads the actual mounted Opus models card with favorite=%s",
  async (favorite) => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const instanceId = ProviderInstanceId.make("claudeAgent");
    const driver = ProviderDriverKind.make("claudeAgent");
    const update = vi.fn();
    const provider: ServerProvider = {
      instanceId,
      driver,
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "unauthenticated" },
      checkedAt: "2026-07-06T00:00:00.000Z",
      models: [{ slug: "opus", name: "Opus 5", isCustom: false, capabilities: null }],
      slashCommands: [],
      skills: [],
      agents: [],
    };
    const Layout = SettingsRoute.options.component!;
    const rootRoute = createRootRoute({
      component: () => (
        <SidebarProvider className="h-dvh! min-h-0! border-t border-panel-separator">
          <Sidebar>
            <SettingsSidebarNav pathname="/settings/providers" />
          </Sidebar>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="min-h-0 min-w-0 flex-1">
              <Layout />
            </div>
          </div>
        </SidebarProvider>
      ),
    });
    const route = createRoute({
      getParentRoute: () => rootRoute,
      path: "/settings/providers",
      component: () => (
        <SettingsPageContainer>
          <ProviderInstanceCard
            instanceId={instanceId}
            instance={{
              driver,
              enabled: true,
              config: { binaryPath: "claude", homePath: "", launchArgs: "" },
            }}
            driverOption={DRIVER_OPTION_BY_VALUE[driver]}
            liveProvider={provider}
            isExpanded
            onExpandedChange={update}
            onUpdate={update}
            hiddenModels={[]}
            favoriteModels={favorite ? ["opus"] : []}
            modelOrder={[]}
            onHiddenModelsChange={update}
            onFavoriteModelsChange={update}
            onModelOrderChange={update}
          />
        </SettingsPageContainer>
      ),
    });
    const router = createRouter({
      origin: "http://127.0.0.1:4885",
      routeTree: rootRoute.addChildren([route]),
      history: createMemoryHistory({ initialEntries: ["/settings/providers"] }),
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const network = vi.fn(() => {
      throw new Error("No network in mounted models seam.");
    });
    vi.stubGlobal("fetch", network);
    try {
      await act(async () => {
        await router.load();
        root.render(<RouterProvider router={router} />);
      });
      const rail = document.createElement("div");
      rail.setAttribute("data-testid", "environment-rail-local");
      rail.setAttribute("aria-checked", "true");
      rail.innerHTML = '<span data-status="connected"></span>';
      container.append(rail);
      vi.stubGlobal("location", new URL("http://127.0.0.1:4885/settings/providers"));
      vi.stubGlobal("innerWidth", 1280);
      vi.stubGlobal("innerHeight", 960);
      // HappyDOM has no layout engine. This checks real UI/reader semantics with ideal geometry.
      const geometry = vi
        .spyOn(HTMLElement.prototype, "getBoundingClientRect")
        .mockReturnValue(new DOMRect(10, 10, 300, 200));
      vi.spyOn(document, "elementFromPoint").mockImplementation(() =>
        document.querySelector('[data-slot="sidebar-inset"]'),
      );
      const source = NodeFS.readFileSync(
        new NodeURL.URL(
          "../../../../desktop/e2e/support/release-visual-settings.ts",
          import.meta.url,
        ),
        "utf8",
      );
      const start = source.indexOf("export function readSettingsVisualWitness(");
      const end = source.indexOf("/** No click admission", start);
      const read = NodeVM.runInNewContext(
        NodeModule.stripTypeScriptTypes(source.slice(start, end)).replace(/^export /gm, "") +
          "\nreadSettingsVisualWitness",
        {
          document,
          location,
          innerWidth,
          innerHeight,
          HTMLElement,
          HTMLInputElement,
          HTMLButtonElement,
          getComputedStyle,
        },
      ) as (input: unknown) => Record<string, boolean>;
      const observe = () =>
        read({
          scene: "settings-provider-form",
          theme: "light",
          origin: "http://127.0.0.1:4885",
          threadId: "owned",
          branch: "codex/delivery-retry-light",
        });
      const custom = container.querySelector<HTMLInputElement>(
        "#provider-instance-claudeAgent-custom-model",
      )!;
      const favoriteButton = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Add Opus 5 to favorites"],button[aria-label="Remove Opus 5 from favorites"]',
      )!;
      expect(custom.value).toBe("");
      expect(favoriteButton).not.toBeNull();
      expect(observe()).toMatchObject({
        modelsVisible: true,
        modelsCustomFieldInView: true,
        modelsCustomFieldReady: true,
        modelControlsVisible: true,
        nonSecretFieldsVisible: true,
        ownedConfigOnly: true,
        targetInView: true,
      });
      custom.value = "Retained custom draft";
      expect(observe()).toMatchObject({
        modelsVisible: false,
        modelsCustomFieldInView: true,
        modelsCustomFieldReady: false,
        modelControlsVisible: true,
      });
      custom.value = "";
      favoriteButton.style.display = "none";
      expect(observe()).toMatchObject({
        modelsVisible: false,
        modelsCustomFieldInView: true,
        modelsCustomFieldReady: true,
        modelControlsVisible: true,
      });
      favoriteButton.style.display = "";
      geometry.mockImplementation(function (this: HTMLElement) {
        return this === custom ? new DOMRect(10, 990, 300, 200) : new DOMRect(10, 10, 300, 200);
      });
      const queryReads = vi.spyOn(document, "querySelectorAll");
      const valueReads = vi.spyOn(custom, "value", "get");
      expect(observe()).toMatchObject({
        modelsVisible: false,
        modelsCustomFieldInView: false,
        modelsCustomFieldReady: false,
        modelControlsVisible: true,
      });
      expect(valueReads).not.toHaveBeenCalled();
      expect(
        queryReads.mock.calls.some(
          ([selector]) =>
            selector ===
            'button[aria-label="Add Opus 5 to favorites"],button[aria-label="Remove Opus 5 from favorites"]',
        ),
      ).toBe(false);
      expect(update).not.toHaveBeenCalled();
      expect(network).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    }
  },
);
