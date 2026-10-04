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
  RouterProvider,
  useLocation,
} from "@tanstack/react-router";
import { EnvironmentId, type SourceControlDiscoveryResult } from "@bibcode/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@bibcode/contracts/settings";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { compile } from "tailwindcss";
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
import { Route as SettingsRoute } from "../../routes/settings";
import { AppStatusBarView } from "../status-bar/AppStatusBar";
import { Sidebar, SidebarProvider } from "../ui/sidebar";
import { SettingsSidebarNav } from "./SettingsSidebarNav";
import { SourceControlSettingsPanel } from "./SourceControlSettings";

const missingDetail = "Command was not found on the server PATH.";
const missingAuth = (detail: string) => ({
  status: "unknown" as const,
  account: Option.none<string>(),
  host: Option.none<string>(),
  detail: Option.some(detail),
});
const discovery: SourceControlDiscoveryResult = {
  versionControlSystems: [
    {
      kind: "git",
      label: "Git",
      executable: "git",
      implemented: true,
      status: "available",
      version: Option.some("git version 2.50.0"),
      installHint: "Install Git from https://git-scm.com/downloads or with your package manager.",
      detail: Option.none(),
    },
    {
      kind: "jj",
      label: "Jujutsu",
      executable: "jj",
      implemented: false,
      status: "missing",
      version: Option.none(),
      installHint: "Install Jujutsu from https://github.com/jj-vcs/jj.",
      detail: Option.some(missingDetail),
    },
  ],
  sourceControlProviders: [
    {
      kind: "github",
      label: "GitHub",
      executable: "gh",
      status: "missing",
      version: Option.none(),
      installHint: "Install GitHub CLI from https://cli.github.com/.",
      detail: Option.some(missingDetail),
      auth: missingAuth("Hosting integration command was not found on the server PATH."),
    },
    {
      kind: "gitlab",
      label: "GitLab",
      executable: "glab",
      status: "missing",
      version: Option.none(),
      installHint: "Install GitLab CLI from https://gitlab.com/gitlab-org/cli.",
      detail: Option.some(missingDetail),
      auth: missingAuth("Hosting integration command was not found on the server PATH."),
    },
    {
      kind: "azure-devops",
      label: "Azure DevOps",
      executable: "az",
      status: "missing",
      version: Option.none(),
      installHint:
        "Install Azure CLI from https://learn.microsoft.com/cli/azure/install-azure-cli.",
      detail: Option.some(missingDetail),
      auth: missingAuth("Hosting integration command was not found on the server PATH."),
    },
    {
      kind: "bitbucket",
      label: "Bitbucket",
      status: "missing",
      version: Option.none(),
      installHint: "Configure Bitbucket API credentials in server settings.",
      detail: Option.none(),
      auth: missingAuth("Bitbucket API credentials are not configured."),
    },
  ],
};

function MountedSettings() {
  const location = useLocation();
  const SettingsLayout = SettingsRoute.options.component!;
  return (
    <SidebarProvider className="h-dvh! min-h-0! border-t border-panel-separator">
      <Sidebar>
        <SettingsSidebarNav pathname={location.pathname} />
      </Sidebar>
      {/* Match __root's flex column, block Outlet host and status-bar sibling. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="min-h-0 min-w-0 flex-1">
          <SettingsLayout />
        </div>
        <AppStatusBarView
          usage={null}
          diagnostics={{ diagnostics: null, queryError: null }}
          localDiagnostics={null}
          terminalCount={0}
          showResourceUsage={false}
          onRefresh={() => {}}
        />
      </div>
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
  const styles = document.createElement("style");
  // HappyDOM rejects dvh and the layer-order statement. Normalize those only
  // for CSS-intent inspection; this test does not simulate browser layout.
  styles.textContent = (await compile("@tailwind utilities;"))
    .build(["h-dvh", "h-dvh!", "h-full", "border-t", "flex", "flex-col", "shrink-0"])
    .replaceAll("@layer properties;", "")
    .replaceAll("100dvh", "100vh");
  document.head.append(styles);
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
          // Only external shell/identity and ideal geometry are inert; panel/hooks/reader remain real.
          const rail = document.createElement("div");
          rail.setAttribute("data-testid", "environment-rail-local");
          rail.setAttribute("aria-checked", "true");
          const connection = document.createElement("span");
          connection.setAttribute("data-status", "connected");
          rail.append(connection);
          document.body.append(rail);
          try {
            vi.stubGlobal("location", {
              origin: "http://127.0.0.1:4885",
              pathname: "/settings/source-control",
              search: "",
              hash: "",
            });
            vi.stubGlobal("innerWidth", 1280);
            vi.stubGlobal("innerHeight", 960);
            vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
              new DOMRect(10, 10, 300, 200),
            );
            vi.spyOn(document, "elementFromPoint").mockImplementation(() =>
              document.querySelector('[data-slot="sidebar-inset"]'),
            );
            const observation = {
              scene: "settings-source-control",
              theme: "light",
              origin: "http://127.0.0.1:4885",
              threadId: "owned",
              branch: "codex/delivery-retry-light",
            } as const;
            // Execute serialized QA source; importing its desktop module violates the web project boundary.
            const readerStart = source.indexOf("export function readSettingsVisualWitness(");
            const readerEnd = source.indexOf("/** No click admission", readerStart);
            const definitionsStart = source.indexOf("export const settingsVisualScenes");
            const definitionsEnd = source.indexOf("const settingsUnpictured =", definitionsStart);
            const captureSource = NodeFS.readFileSync(
              new NodeURL.URL(
                "../../../../desktop/e2e/support/remote-ui-evidence.ts",
                import.meta.url,
              ),
              "utf8",
            );
            const captureStart = captureSource.indexOf("const witnessKeys =");
            const captureEnd = captureSource.indexOf("/** Parse only", captureStart);
            for (const [first, last] of [
              [readerStart, readerEnd],
              [definitionsStart, definitionsEnd],
              [captureStart, captureEnd],
            ] as const) {
              expect(first).toBeGreaterThan(0);
              expect(last).toBeGreaterThan(first);
            }
            const actual = NodeVM.runInNewContext(
              NodeModule.stripTypeScriptTypes(
                captureSource.slice(captureStart, captureEnd) +
                  source.slice(definitionsStart, definitionsEnd) +
                  source.slice(readerStart, readerEnd) +
                  "\n({readSettingsVisualWitness, validateSettingsVisualWitness})",
              ).replace(/^export /gm, ""),
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
            ) as {
              readSettingsVisualWitness: (
                input: typeof observation,
              ) => Record<string, boolean> | null;
              validateSettingsVisualWitness: (
                scene: "settings-source-control",
                input: unknown,
              ) => Record<string, true>;
            };
            const { validateSettingsVisualWitness } = actual;
            const read = () => actual.readSettingsVisualWitness(observation);
            const witness = read();
            expect(witness).toMatchObject({
              expectedTextMatched: true,
              gitAvailable: true,
              hostingUnavailable: true,
              targetInView: true,
            });
            expect(validateSettingsVisualWitness("settings-source-control", witness)).toEqual(
              witness,
            );
            const shell = document.querySelector<HTMLElement>('[data-slot="sidebar-wrapper"]')!;
            const inset = document.querySelector<HTMLElement>('[data-slot="sidebar-inset"]')!;
            const declaredHeight = (element: HTMLElement) =>
              Array.from(styles.sheet!.cssRules).find(
                (rule) =>
                  rule instanceof CSSStyleRule &&
                  rule.style.height !== "" &&
                  element.matches(rule.selectorText),
              ) as CSSStyleRule | undefined;
            const outletHost = inset.parentElement!;
            const column = outletHost.parentElement!;
            const statusBar = document.querySelector<HTMLElement>("[data-status-bar]")!;
            expect(getComputedStyle(column).display).toBe("flex");
            expect(getComputedStyle(column).flexDirection).toBe("column");
            expect(getComputedStyle(outletHost).display).toBe("block");
            expect(statusBar.parentElement).toBe(column);
            expect(getComputedStyle(statusBar).flexShrink).toBe("0");
            expect(declaredHeight(shell)?.style.height).toBe("100vh");
            expect(Number.parseFloat(getComputedStyle(shell).borderTopWidth)).toBe(1);
            // The block Outlet host cannot stretch an auto-height child. Fill
            // its allotted height, which excludes the status bar and shell border.
            expect(declaredHeight(inset)?.style.height).toBe("100%");
            for (const label of ["Git", "GitHub", "GitLab"]) {
              const original = document.querySelector<HTMLElement>(
                `[role="switch"][aria-label="${label} availability"]`,
              )!;
              expect(original.hasAttribute("disabled")).toBe(false);
              expect(original.getAttribute("aria-disabled")).toBe("true");
              const checked = original.getAttribute("aria-checked")!;
              const fact = label === "Git" ? "gitAvailable" : "hostingUnavailable";
              // Negative mutations are confined to this inert DOM and restored before the next case.
              for (const value of [null, "false", "TRUE", "true "]) {
                try {
                  if (value === null) original.removeAttribute("aria-disabled");
                  else original.setAttribute("aria-disabled", value);
                  expect(original.hasAttribute("data-disabled")).toBe(true);
                  const refused = read();
                  expect(refused?.[fact]).toBe(false);
                  expect(() =>
                    validateSettingsVisualWitness("settings-source-control", refused),
                  ).toThrow("Visual settings precondition failed.");
                } finally {
                  original.setAttribute("aria-disabled", "true");
                }
              }
              try {
                original.setAttribute("aria-checked", checked === "true" ? "false" : "true");
                const refused = read();
                expect(refused?.[fact]).toBe(false);
                expect(() =>
                  validateSettingsVisualWitness("settings-source-control", refused),
                ).toThrow("Visual settings precondition failed.");
              } finally {
                original.setAttribute("aria-checked", checked);
              }
              const replacement = document.createElement("button");
              replacement.setAttribute("role", "switch");
              replacement.setAttribute("aria-label", `${label} availability`);
              replacement.setAttribute("aria-checked", checked);
              replacement.setAttribute("data-disabled", "");
              replacement.style.opacity = "0.64";
              replacement.style.pointerEvents = "none";
              replacement.textContent = "Disabled";
              try {
                original.replaceWith(replacement);
                const refused = read();
                expect(refused?.[fact]).toBe(false);
                expect(() =>
                  validateSettingsVisualWitness("settings-source-control", refused),
                ).toThrow("Visual settings precondition failed.");
                // A genuine native disabled attribute remains an independent admitted form.
                replacement.disabled = true;
                expect(
                  validateSettingsVisualWitness("settings-source-control", read()),
                ).toMatchObject({ gitAvailable: true, hostingUnavailable: true });
              } finally {
                replacement.replaceWith(original);
              }
            }
            expect(validateSettingsVisualWitness("settings-source-control", read())).toEqual(
              witness,
            );
          } finally {
            rail.remove();
          }
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
    styles.remove();
    registry.dispose();
    __resetClientSettingsPersistenceForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  }
}, 5_000);
