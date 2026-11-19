import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EnvironmentId } from "@bibcode/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  environments: [] as Array<unknown>,
  isReady: true,
  activeEnvironmentId: null as string | null,
  setActiveEnvironmentId: vi.fn(),
  navigate: vi.fn(),
  mobile: { isMobile: false, setOpenMobile: vi.fn() },
  catalogCommandCalls: [] as Array<string>,
  buttons: [] as Array<Record<string, unknown>>,
  menuItems: [] as Array<Record<string, unknown>>,
  updateSnapshots: new Map<string, unknown>(),
  showContextMenu: vi.fn<(items: unknown, position: unknown) => Promise<string | null>>(),
  reset() {
    h.showContextMenu.mockReset();
    h.showContextMenu.mockResolvedValue(null);
    h.environments = [];
    h.isReady = true;
    h.activeEnvironmentId = null;
    h.setActiveEnvironmentId.mockReset();
    h.navigate.mockReset();
    h.catalogCommandCalls = [];
    h.buttons = [];
    h.menuItems = [];
    h.updateSnapshots.clear();
  },
}));

vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: h.environments, isReady: h.isReady }),
}));
vi.mock("../../state/entities", () => ({
  useActiveEnvironmentId: () => h.activeEnvironmentId,
  setActiveEnvironmentId: h.setActiveEnvironmentId,
}));
vi.mock("../../connection/environmentCompat", () => ({
  resolveEnvironmentCompatVerdict: () => null,
  selectRemoteUpdateControlCapability: (serverConfig: unknown) =>
    (serverConfig as { environment?: { capabilities?: { remoteUpdateControl?: boolean } } } | null)
      ?.environment?.capabilities?.remoteUpdateControl === true,
}));
vi.mock("../../state/remoteUpdates", () => ({
  remoteUpdateEnvironment: {
    snapshot: ({ environmentId }: { environmentId: string }) => ({
      __kind: "remoteUpdateSnapshot",
      environmentId,
    }),
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: { __kind?: string; environmentId?: string } | null) => ({
    data:
      atom?.__kind === "remoteUpdateSnapshot" && atom.environmentId !== undefined
        ? (h.updateSnapshots.get(atom.environmentId) ?? null)
        : null,
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));
vi.mock("../../connection/catalog", () => ({
  environmentCatalog: new Proxy(
    {},
    {
      get: (_target, key) => {
        h.catalogCommandCalls.push(String(key));
        return {};
      },
    },
  ),
}));
vi.mock("../../localApi", () => ({
  readLocalApi: () => ({ contextMenu: { show: h.showContextMenu } }),
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("~/components/ui/sidebar", () => ({ useSidebar: () => h.mobile }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => h.navigate,
  useRouter: () => ({
    buildLocation: () => ({ pathname: "/environment/target/terminal" }),
    state: { location: { pathname: "/" } },
  }),
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipPopup: () => null,
  TooltipTrigger: ({ render, children }: { render?: ReactElement; children?: ReactNode }) => {
    if (render) {
      h.buttons.push({ ...(render.props as Record<string, unknown>) });
    }
    return <>{children}</>;
  },
}));
vi.mock("../ui/menu", () => ({
  Menu: ({ children }: { children?: ReactNode }) => <>{children}</>,
  MenuPopup: ({ children }: { children?: ReactNode }) => <>{children}</>,
  MenuTrigger: ({ render, children }: { render?: ReactElement; children?: ReactNode }) => {
    if (render) {
      h.buttons.push({ ...(render.props as Record<string, unknown>) });
    }
    return <>{children}</>;
  },
  MenuItem: (props: Record<string, unknown>) => {
    h.menuItems.push(props);
    return null;
  },
}));

const effects: Array<() => void | (() => void)> = [];
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void)) => {
      effects.push(effect);
    },
  };
});

import { EnvironmentRail } from "./EnvironmentRail";

const ENV_PRIMARY = EnvironmentId.make("env-primary");
const ENV_REMOTE = EnvironmentId.make("env-remote");
const ENV_WSL = EnvironmentId.make("env-wsl");

function environment(input: {
  environmentId: string;
  label: string;
  target: Record<string, unknown>;
  phase?: string;
  remoteUpdateControl?: boolean;
}) {
  return {
    environmentId: input.environmentId,
    label: input.label,
    entry: { target: input.target },
    connection: { phase: input.phase ?? "connected", error: null, traceId: null },
    serverConfig:
      input.remoteUpdateControl === undefined
        ? null
        : {
            environment: {
              capabilities: { remoteUpdateControl: input.remoteUpdateControl },
            },
          },
  };
}

function renderRail() {
  effects.length = 0;
  h.buttons = [];
  h.menuItems = [];
  return renderToStaticMarkup(<EnvironmentRail />);
}

function buttonByTestId(testId: string) {
  return h.buttons.find((props) => props["data-testid"] === testId);
}

describe("EnvironmentRail", () => {
  it("renders Local plus remote entries with radio semantics", () => {
    h.reset();
    h.environments = [
      environment({
        environmentId: ENV_PRIMARY,
        label: "Local",
        target: { _tag: "PrimaryConnectionTarget" },
      }),
      environment({
        environmentId: ENV_REMOTE,
        label: "AI-SERVER",
        target: { _tag: "BearerConnectionTarget", connectionId: "paired-1" },
      }),
    ];
    h.activeEnvironmentId = ENV_PRIMARY;
    const markup = renderRail();
    expect(markup).toContain('role="radiogroup"');
    const local = buttonByTestId("environment-rail-local");
    expect(local?.["aria-checked"]).toBe(true);
    expect(local?.["data-selected"]).toBe(true);
    expect(local?.className).toContain("ring-primary");
    expect(local?.tabIndex).toBe(0);
    const remote = buttonByTestId(`environment-rail-entry-${ENV_REMOTE}`);
    expect(remote?.["aria-checked"]).toBe(false);
    expect(remote?.["data-selected"]).toBe(false);
    expect(remote?.className).not.toContain("ring-primary");
    expect(remote?.tabIndex).toBe(-1);
    expect(buttonByTestId("environment-rail-add-server")).toBeDefined();
    expect(buttonByTestId("environment-rail-manage")).toBeDefined();
  });

  it("stays visible with zero saved remotes", () => {
    h.reset();
    h.environments = [
      environment({
        environmentId: ENV_PRIMARY,
        label: "Local",
        target: { _tag: "PrimaryConnectionTarget" },
      }),
    ];
    h.activeEnvironmentId = ENV_PRIMARY;
    const markup = renderRail();
    expect(markup).toContain('data-testid="environment-rail"');
    expect(buttonByTestId("environment-rail-local")).toBeDefined();
    expect(markup).not.toContain('data-testid="environment-rail-divider"');
    // The fixed sidebar toggle is pinned over the rail's top strip, so the rail
    // reserves the topbar height ahead of the environments group; otherwise
    // the toggle sits on the Local entry and clicking Local collapses the sidebar.
    const topbar = markup.indexOf('data-testid="environment-rail-topbar"');
    const environments = markup.indexOf('aria-label="Environments"');
    expect(topbar).toBeGreaterThan(-1);
    expect(topbar).toBeLessThan(environments);
    expect(markup).toMatch(/environment-rail-topbar"[^>]*class="[^"]*workspace-topbar[^"]*"/);
  });

  it("writes selection to the active-environment atom and nothing else", () => {
    h.reset();
    h.environments = [
      environment({
        environmentId: ENV_PRIMARY,
        label: "Local",
        target: { _tag: "PrimaryConnectionTarget" },
      }),
      environment({
        environmentId: ENV_REMOTE,
        label: "AI-SERVER",
        target: { _tag: "BearerConnectionTarget", connectionId: "paired-1" },
      }),
    ];
    h.activeEnvironmentId = ENV_PRIMARY;
    renderRail();
    const remote = buttonByTestId(`environment-rail-entry-${ENV_REMOTE}`);
    expect(remote).toBeDefined();
    (remote!.onClick as () => void)();
    expect(h.setActiveEnvironmentId).toHaveBeenCalledExactlyOnceWith(ENV_REMOTE);
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.catalogCommandCalls).toEqual([]);
  });

  it("shows an amber attention dot when a capable remote has an update available", () => {
    h.reset();
    h.environments = [
      environment({
        environmentId: ENV_PRIMARY,
        label: "Local",
        target: { _tag: "PrimaryConnectionTarget" },
      }),
      environment({
        environmentId: ENV_REMOTE,
        label: "AI-SERVER",
        target: { _tag: "BearerConnectionTarget", connectionId: "paired-1" },
        remoteUpdateControl: true,
      }),
    ];
    h.updateSnapshots.set(ENV_REMOTE, {
      serverVersion: "0.4.2",
      latestVersion: "0.5.0",
      state: "update-available",
      error: null,
      support: { installMode: "interactive", reason: "available", installKind: "unknown" },
      downloadPercent: null,
      targetVersion: null,
      installStage: null,
    });

    expect(renderRail()).toContain('data-status="attention"');
  });

  it("groups desktop-local backends under the Local sub-picker", () => {
    h.reset();
    h.environments = [
      environment({
        environmentId: ENV_PRIMARY,
        label: "Local",
        target: { _tag: "PrimaryConnectionTarget" },
      }),
      environment({
        environmentId: ENV_WSL,
        label: "Ubuntu",
        target: { _tag: "BearerConnectionTarget", connectionId: "local:wsl-ubuntu" },
      }),
    ];
    h.activeEnvironmentId = ENV_PRIMARY;
    renderRail();
    expect(h.menuItems.map((item) => item.children)).toEqual(["This device", "Ubuntu"]);
    const ubuntu = h.menuItems[1];
    expect(ubuntu).toBeDefined();
    (ubuntu!.onClick as () => void)();
    expect(h.setActiveEnvironmentId).toHaveBeenCalledExactlyOnceWith(ENV_WSL);
  });

  it("deep-links bottom actions to Remote Servers settings", () => {
    h.reset();
    h.environments = [
      environment({
        environmentId: ENV_PRIMARY,
        label: "Local",
        target: { _tag: "PrimaryConnectionTarget" },
      }),
    ];
    renderRail();
    const addServer = buttonByTestId("environment-rail-add-server");
    expect(addServer).toBeDefined();
    (addServer!.onClick as () => void)();
    expect(h.navigate).toHaveBeenCalledWith({
      to: "/settings/remote-servers",
      search: { action: "add-server" },
    });
    const manage = buttonByTestId("environment-rail-manage");
    expect(manage).toBeDefined();
    (manage!.onClick as () => void)();
    expect(h.navigate).toHaveBeenCalledWith({ to: "/settings/remote-servers" });
    expect(h.setActiveEnvironmentId).not.toHaveBeenCalled();
  });

  it("resets a stale selection to Local once the catalog is ready", () => {
    h.reset();
    h.environments = [
      environment({
        environmentId: ENV_PRIMARY,
        label: "Local",
        target: { _tag: "PrimaryConnectionTarget" },
      }),
    ];
    h.activeEnvironmentId = ENV_REMOTE;
    renderRail();
    for (const effect of effects) effect();
    expect(h.setActiveEnvironmentId).toHaveBeenCalledExactlyOnceWith(ENV_PRIMARY);
  });

  describe("server commands menu (#378)", () => {
    const BOTH_COMMANDS = [
      { id: "terminal", label: "Open terminal" },
      { id: "dashboard", label: "Dashboard" },
    ];

    function railWith(...extra: ReturnType<typeof environment>[]) {
      h.reset();
      h.environments = [
        environment({
          environmentId: ENV_PRIMARY,
          label: "Local",
          target: { _tag: "PrimaryConnectionTarget" },
        }),
        ...extra,
      ];
      h.activeEnvironmentId = ENV_PRIMARY;
      renderRail();
    }

    const remoteServer = (phase = "connected") =>
      environment({
        environmentId: ENV_REMOTE,
        label: "Server A",
        target: { _tag: "BearerConnectionTarget", connectionId: "paired-1" },
        phase,
      });

    function rightClick(testId: string) {
      const preventDefault = vi.fn();
      const button = buttonByTestId(testId);
      expect(button, testId).toBeDefined();
      (button!.onContextMenu as (event: unknown) => void)({
        preventDefault,
        clientX: 40,
        clientY: 80,
      });
      return preventDefault;
    }

    function keyDown(testId: string, init: Record<string, unknown>) {
      const event = {
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        currentTarget: { getBoundingClientRect: () => ({ left: 12.4, bottom: 52.6 }) },
        ...init,
      };
      (buttonByTestId(testId)!.onKeyDown as (event: unknown) => void)(event);
      return event;
    }

    it("right-click on a saved server shows Open terminal then Dashboard and runs the pick", async () => {
      railWith(remoteServer());
      h.showContextMenu.mockResolvedValue("dashboard");
      const preventDefault = rightClick(`environment-rail-entry-${ENV_REMOTE}`);
      expect(preventDefault, "the browser menu must not appear").toHaveBeenCalled();
      expect(h.showContextMenu).toHaveBeenCalledExactlyOnceWith(BOTH_COMMANDS, { x: 40, y: 80 });
      await vi.waitFor(() =>
        expect(h.navigate).toHaveBeenCalledExactlyOnceWith({
          to: "/environment/$environmentId/dashboard",
          params: { environmentId: ENV_REMOTE },
        }),
      );
      expect(
        h.setActiveEnvironmentId,
        "the menu never changes the selection",
      ).not.toHaveBeenCalled();
    });

    it("right-click on Local targets this device, also before anything is selected", async () => {
      railWith(remoteServer());
      h.activeEnvironmentId = null;
      renderRail();
      h.showContextMenu.mockResolvedValue("terminal");
      rightClick("environment-rail-local");
      expect(h.showContextMenu).toHaveBeenCalledExactlyOnceWith(BOTH_COMMANDS, { x: 40, y: 80 });
      await vi.waitFor(() =>
        expect(h.navigate).toHaveBeenCalledExactlyOnceWith({
          to: "/environment/$environmentId/terminal",
          params: { environmentId: ENV_PRIMARY },
          search: { open: expect.any(Number) },
        }),
      );
    });

    it("the Local menu acts on the local backend in view, and Local keeps its picker", async () => {
      railWith(
        environment({
          environmentId: ENV_WSL,
          label: "Ubuntu",
          target: { _tag: "BearerConnectionTarget", connectionId: "local:wsl-ubuntu" },
        }),
      );
      h.activeEnvironmentId = ENV_WSL;
      renderRail();
      expect(h.menuItems.map((item) => item.children)).toEqual(["This device", "Ubuntu"]);
      h.showContextMenu.mockResolvedValue("terminal");
      rightClick("environment-rail-local");
      await vi.waitFor(() =>
        expect(h.navigate).toHaveBeenCalledWith({
          to: "/environment/$environmentId/terminal",
          params: { environmentId: ENV_WSL },
          search: { open: expect.any(Number) },
        }),
      );
    });

    it("Shift+F10 and the Menu key open the menu at the icon, once", () => {
      railWith(remoteServer());
      const testId = `environment-rail-entry-${ENV_REMOTE}`;
      const shiftF10 = keyDown(testId, { key: "F10", shiftKey: true });
      expect(shiftF10.preventDefault).toHaveBeenCalled();
      expect(shiftF10.stopPropagation).toHaveBeenCalled();
      expect(h.showContextMenu).toHaveBeenCalledExactlyOnceWith(BOTH_COMMANDS, { x: 12, y: 53 });
      // Chromium follows the shortcut with a contextmenu event; it must not open a second menu.
      rightClick(testId);
      expect(h.showContextMenu).toHaveBeenCalledTimes(1);

      railWith(remoteServer());
      keyDown("environment-rail-local", { key: "ContextMenu" });
      expect(h.showContextMenu).toHaveBeenCalledExactlyOnceWith(BOTH_COMMANDS, { x: 12, y: 53 });
    });

    it("arrow keys still move focus and do not open the menu", () => {
      railWith(remoteServer());
      const arrow = keyDown(`environment-rail-entry-${ENV_REMOTE}`, { key: "ArrowDown" });
      expect(arrow.preventDefault).not.toHaveBeenCalled();
      expect(arrow.stopPropagation, "the radiogroup handler still sees it").not.toHaveBeenCalled();
      expect(h.showContextMenu).not.toHaveBeenCalled();
    });

    it("an offline server lists both commands disabled with the reason", async () => {
      railWith(remoteServer("disconnected"));
      rightClick(`environment-rail-entry-${ENV_REMOTE}`);
      const reason = "Server A is not connected.";
      expect(h.showContextMenu).toHaveBeenCalledExactlyOnceWith(
        [
          { id: "terminal", label: "Open terminal", disabled: true, description: reason },
          { id: "dashboard", label: "Dashboard", disabled: true, description: reason },
        ],
        { x: 40, y: 80 },
      );
      await Promise.resolve();
      expect(h.navigate).not.toHaveBeenCalled();
    });

    it("closes the phone sidebar so the opened panel is visible", async () => {
      railWith(remoteServer());
      h.mobile = { isMobile: true, setOpenMobile: vi.fn() };
      renderRail();
      h.showContextMenu.mockResolvedValue("dashboard");
      rightClick(`environment-rail-entry-${ENV_REMOTE}`);
      await vi.waitFor(() => expect(h.navigate).toHaveBeenCalled());
      expect(h.mobile.setOpenMobile).toHaveBeenCalledExactlyOnceWith(false);
      h.mobile = { isMobile: false, setOpenMobile: vi.fn() };
    });

    it("dismissing the menu opens nothing and selects nothing", async () => {
      railWith(remoteServer());
      rightClick(`environment-rail-entry-${ENV_REMOTE}`);
      await h.showContextMenu.mock.results[0]!.value;
      await Promise.resolve();
      expect(h.navigate).not.toHaveBeenCalled();
      expect(h.setActiveEnvironmentId).not.toHaveBeenCalled();
    });
  });

  it("does not reset while the catalog is loading", () => {
    h.reset();
    h.isReady = false;
    h.activeEnvironmentId = ENV_REMOTE;
    renderRail();
    for (const effect of effects) effect();
    expect(h.setActiveEnvironmentId).not.toHaveBeenCalled();
  });
});
