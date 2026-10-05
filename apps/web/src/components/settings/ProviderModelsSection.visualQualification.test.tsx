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

function installedSdkScroll(browser: unknown) {
  const require = NodeModule.createRequire(
    new NodeURL.URL("../../../../desktop/package.json", import.meta.url),
  );
  const source = NodeFS.readFileSync(
    new NodeURL.URL("node.js", NodeURL.pathToFileURL(require.resolve("webdriverio"))),
    "utf8",
  );
  const between = (start: string, end: string) => {
    const first = source.indexOf(start);
    const last = source.indexOf(end, first + start.length);
    expect(first).toBeGreaterThan(0);
    expect(last).toBeGreaterThan(first);
    return source.slice(first, last);
  };
  const sdk = NodeVM.runInNewContext(
    between("var BaseAction = class", "\n//") +
      between("var DEFAULT_SCROLL_PARAMS", "// src/commands/browser/action.ts") +
      between("async function scrollIntoView(", "async function mobileScrollUntilVisible(") +
      between("function scrollIntoViewWeb(", "\n//") +
      "\n({ WheelAction, scrollIntoView })",
    {
      window,
      getBrowserObject30: (element: { parent: unknown }) => element.parent,
      ELEMENT_KEY3: "element-6066-11e4-a52e-4f735466cecf",
      ELEMENT_KEY17: "element-6066-11e4-a52e-4f735466cecf",
      keyActionIds: 0,
      pointerActionIds: 0,
      wheelActionIds: 0,
      log27: {
        warn: () => {
          throw new Error("Unexpected SDK scroll fallback.");
        },
      },
    },
  );
  return {
    scroll: (element: unknown, options: ScrollIntoViewOptions) =>
      sdk.scrollIntoView.call(element, options),
    action: () => new sdk.WheelAction(browser),
  };
}

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
      models: [
        { slug: "opus", name: "Opus 5", isCustom: false, capabilities: null },
        { slug: "sonnet", name: "Sonnet 5", isCustom: false, capabilities: null },
      ],
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
        binaryFieldPresent: true,
        binaryFieldVisible: true,
        binaryFieldViewportContained: true,
        binaryFieldAncestorsContained: true,
        modelsCustomFieldPresent: true,
        modelsCustomFieldVisible: true,
        modelsCustomFieldViewportContained: true,
        modelsCustomFieldAncestorsContained: true,
        modelOrderControlPresent: true,
        modelOrderControlVisible: true,
        modelOrderControlViewportContained: true,
        modelOrderControlAncestorsContained: true,
        modelsVisible: true,
        modelsCustomFieldInView: true,
        modelsCustomFieldReady: true,
        modelControlsVisible: true,
        nonSecretFieldsVisible: true,
        ownedConfigOnly: true,
        targetInView: true,
      });
      const page = custom.closest<HTMLElement>(".scrollbar-gutter-both")!;
      const panel = custom.closest<HTMLElement>('[data-slot="collapsible-panel"]')!;
      const list = favoriteButton.closest<HTMLElement>(".overflow-y-auto")!;
      const order = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Move Opus 5 up"]',
      )!;
      const binary = container.querySelector<HTMLInputElement>(
        "#provider-instance-claudeAgent-binaryPath",
      )!;
      const home = container.querySelector<HTMLInputElement>(
        "#provider-instance-claudeAgent-homePath",
      )!;
      const args = container.querySelector<HTMLInputElement>(
        "#provider-instance-claudeAgent-launchArgs",
      )!;
      expect(panel.classList.contains("overflow-hidden")).toBe(true);
      expect(list.classList.contains("max-h-40")).toBe(true);
      page.style.overflowY = "auto";
      panel.style.overflowY = "hidden";
      list.style.overflowY = "auto";
      const positions = new Map<HTMLElement, number>([
        [binary, 680],
        [home, 744],
        [args, 808],
        [favoriteButton, 936],
        [order, 936],
        [custom, 1064],
      ]);
      // A constructed 416px field span fits this 820px scrollport; this is not browser layout evidence.
      geometry.mockImplementation(function (this: HTMLElement) {
        if (this === page) return new DOMRect(10, 80, 900, 820);
        if (this === panel) return new DOMRect(10, 200 - page.scrollTop, 900, 1800);
        if (this === list) return new DOMRect(10, 920 - page.scrollTop, 900, 160);
        const top = positions.get(this);
        return top === undefined
          ? new DOMRect(10, 10, 300, 200)
          : new DOMRect(10, top - page.scrollTop, 300, 32);
      });
      const nativeScrolls: ScrollIntoViewOptions[] = [];
      vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(
        function (this: HTMLElement, options) {
          const value = options as ScrollIntoViewOptions;
          expect([binary, custom]).toContain(this);
          nativeScrolls.push(value);
          const target = positions.get(this)!;
          page.scrollTop = Math.max(0, value.block === "start" ? target - 80 : target + 32 - 900);
        },
      );
      const actions: Array<{ deltaX: number; deltaY: number }> = [];
      const nodes = new Map<string, HTMLElement>();
      let ordinal = 0;
      let sdk: ReturnType<typeof installedSdkScroll>;
      const browser = {
        isMobile: false,
        getElementRect: async (id: string) => nodes.get(id)!.getBoundingClientRect(),
        getWindowSize: async () => ({ width: innerWidth, height: innerHeight }),
        execute: async (callback: (...values: unknown[]) => unknown, ...values: unknown[]) =>
          callback(...values),
        action: () => sdk.action(),
        performActions: async (
          payloads: Array<{ actions: Array<{ deltaX: number; deltaY: number }> }>,
        ) => {
          // Inert successful wheel transport: zero deltas cannot establish a scrolling action.
          for (const payload of payloads)
            for (const action of payload.actions) actions.push(action);
        },
        releaseActions: async () => {},
        $: (selector: string) => {
          const node = container.querySelector<HTMLElement>(selector)!;
          const id = `owned-field-${++ordinal}`;
          nodes.set(id, node);
          const element: Record<string, unknown> = {
            parent: browser,
            elementId: id,
            "element-6066-11e4-a52e-4f735466cecf": id,
          };
          return {
            ...element,
            scrollIntoView: (options: ScrollIntoViewOptions) => sdk.scroll(element, options),
          };
        },
      };
      sdk = installedSdkScroll(browser);
      await browser
        .$("#provider-instance-claudeAgent-custom-model")
        .scrollIntoView({ block: "end" });
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({ deltaX: 0, deltaY: 0 });
      expect(nativeScrolls).toHaveLength(0);
      expect(observe()).toMatchObject({
        nonSecretFieldsVisible: true,
        modelsCustomFieldInView: false,
        modelControlsVisible: false,
      });
      const scrollStart = source.indexOf(
        "  const scroll = async",
        source.indexOf("export async function runVisualSettings("),
      );
      const scrollEnd = source.indexOf("  const closeOverlay", scrollStart);
      const nativeStart = source.indexOf("export function scrollSettingsVisualField(");
      const nativeEnd = source.indexOf("export interface SettingsVisualInput", nativeStart);
      const nativeSource = nativeStart === -1 ? "" : source.slice(nativeStart, nativeEnd);
      const actualScroll = NodeVM.runInNewContext(
        NodeModule.stripTypeScriptTypes(
          nativeSource + source.slice(scrollStart, scrollEnd) + "\nscroll",
        ).replace(/^export /gm, ""),
        {
          browser,
          bounded: async (value: Promise<unknown>) => value,
          readVisualPageScroll: () => ({ x: 0, y: 0 }),
          input: {
            scene: "settings-provider-form",
            theme: "light",
            origin: location.origin,
            threadId: "owned",
            branch: "codex/delivery-retry-light",
          },
          document,
          location,
          HTMLElement,
          HTMLInputElement,
        },
      );
      await actualScroll("#provider-instance-claudeAgent-binaryPath", "start");
      await actualScroll("#provider-instance-claudeAgent-custom-model", "end");
      expect(nativeScrolls).toEqual([
        { block: "start", inline: "nearest" },
        { block: "end", inline: "nearest" },
      ]);
      expect(observe()).toMatchObject({
        nonSecretFieldsVisible: true,
        modelsCustomFieldInView: true,
        modelsCustomFieldReady: true,
        modelsVisible: true,
        modelControlsVisible: true,
      });
      positions.set(custom, 1700);
      await actualScroll("#provider-instance-claudeAgent-custom-model", "end");
      expect(observe()).toMatchObject({
        nonSecretFieldsVisible: false,
        modelsCustomFieldInView: true,
      });
      page.scrollTop = 0;
      page.style.overflowY = panel.style.overflowY = list.style.overflowY = "";
      geometry.mockReturnValue(new DOMRect(10, 10, 300, 200));
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
        modelsCustomFieldPresent: true,
        modelsCustomFieldVisible: true,
        modelsCustomFieldViewportContained: false,
        modelsCustomFieldAncestorsContained: false,
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
      const parent = custom.parentElement!;
      custom.remove();
      expect(observe()).toMatchObject({
        modelsCustomFieldPresent: false,
        modelsCustomFieldVisible: false,
        modelsCustomFieldViewportContained: false,
        modelsCustomFieldAncestorsContained: false,
        modelsCustomFieldInView: false,
      });
      parent.append(custom);
      custom.style.display = "none";
      expect(observe()).toMatchObject({
        modelsCustomFieldPresent: true,
        modelsCustomFieldVisible: false,
        modelsCustomFieldViewportContained: false,
        modelsCustomFieldAncestorsContained: false,
        modelsCustomFieldInView: false,
      });
      custom.style.display = "";
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
