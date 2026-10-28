// @vitest-environment happy-dom

/**
 * Following a thread's Diagnostics link through the router to a download: the link carries
 * the thread's environment, the Diagnostics route keeps it, and Download logs sends the
 * request over that environment's connection, never the primary's HTTP route.
 */
import { EnvironmentId } from "@bibcode/contracts";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

interface FakeEnvironment {
  readonly environmentId: string;
  readonly label: string;
  readonly connection: { readonly phase: string };
  readonly serverConfig: {
    readonly environment: { readonly capabilities: { readonly diagnosticLogs: boolean } };
  };
}

const h = vi.hoisted(() => ({
  primary: null as FakeEnvironment | null,
  environments: [] as FakeEnvironment[],
  environmentCalls: [] as Array<{ environmentId: string; label: string }>,
  primaryCalls: 0,
  saved: [] as string[],
}));

vi.mock("../state/environments", () => ({
  usePrimaryEnvironment: () => h.primary,
  useEnvironments: () => ({ environments: h.environments, isReady: true }),
}));

// The page as far as the download goes: the panel hands the route's environment to the
// Diagnostic logs section exactly as DiagnosticsSettingsPanel does.
vi.mock("../components/settings/DiagnosticsSettings", async () => {
  const { DiagnosticLogsSection } = await vi.importActual<
    typeof import("../components/settings/DiagnosticLogsSection")
  >("../components/settings/DiagnosticLogsSection");
  return {
    DiagnosticsSettingsPanel: (props: {
      profilerEnvironmentId: EnvironmentId | null;
      onProfilerEnvironmentChange: (environmentId: EnvironmentId | null) => void;
    }) => (
      <DiagnosticLogsSection
        selectedEnvironmentId={props.profilerEnvironmentId}
        onSelectEnvironment={props.onProfilerEnvironmentChange}
      />
    ),
  };
});

vi.mock("../components/settings/settingsLayout", () => ({
  SettingsSection: (props: { children: ReactNode }) => <section>{props.children}</section>,
  SettingsRow: (props: { status: ReactNode; control: ReactNode }) => (
    <div>
      <div data-status>{props.status}</div>
      {props.control}
    </div>
  ),
}));

// The RPC seam: which environment's connection carries the download.
vi.mock("../diagnostics/environmentDiagnosticLogs", () => ({
  downloadEnvironmentDiagnosticLogs: async (environmentId: string, label: string) => {
    h.environmentCalls.push({ environmentId, label });
    return { fileName: "bibcode-diagnostics-omarchy.zip", bytes: new Uint8Array([1]) };
  },
}));

// The primary's HTTP route; reaching it would mean the link fell back to local logs.
vi.mock("../lib/runtime", () => ({
  runPrimaryRawHttp: async () => {
    h.primaryCalls += 1;
    throw new Error("The primary's logs were requested.");
  },
}));

vi.mock("../diagnostics/frontendLogCapture", () => ({
  readFrontendLogSnapshot: () => "frontend snapshot\n",
}));

vi.mock("../components/ui/toast", () => ({ toastManager: { add: () => {} } }));

vi.mock("../components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipPopup: () => null,
}));

import { ThreadErrorBanner } from "../components/chat/ThreadErrorBanner";
import { Route as DiagnosticsRoute } from "./settings.diagnostics";

const OMARCHY = "environment-Omarchy";

function environment(label: string, phase = "connected"): FakeEnvironment {
  return {
    environmentId: `environment-${label}`,
    label,
    connection: { phase },
    serverConfig: { environment: { capabilities: { diagnosticLogs: true } } },
  };
}

let mounted: { root: Root; container: HTMLDivElement } | null = null;

async function renderAtThread() {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const threadRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/thread",
    component: () => (
      <ThreadErrorBanner
        error="Claude reported an error."
        diagnosticsEnvironmentId={EnvironmentId.make(OMARCHY)}
      />
    ),
  });
  const diagnosticsRoute = DiagnosticsRoute.update({
    id: "/settings/diagnostics",
    path: "/settings/diagnostics",
    getParentRoute: () => rootRoute,
  } as never);
  const router = createRouter({
    routeTree: rootRoute.addChildren([threadRoute, diagnosticsRoute]),
    history: createMemoryHistory({ initialEntries: ["/thread"] }),
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted = { root, container };
  await act(async () => {
    root.render(<RouterProvider router={router} />);
  });
  await act(async () => router.load());
  return { router, container };
}

async function click(element: Element | null) {
  if (element === null) throw new Error("Nothing to click.");
  await act(async () => {
    (element as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const findByText = (container: HTMLElement, text: string) =>
  Array.from(container.querySelectorAll("a, button")).find(
    (element) => element.textContent?.trim() === text,
  ) ?? null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.primary = environment("Work Server");
  h.environments = [h.primary, environment("Omarchy")];
  h.environmentCalls.length = 0;
  h.primaryCalls = 0;
  h.saved.length = 0;
  (window as { desktopBridge?: unknown }).desktopBridge = {
    saveDiagnosticLogs: async (filename: string) => {
      h.saved.push(filename);
      return `/Downloads/${filename}`;
    },
  };
});

afterEach(async () => {
  if (mounted !== null) {
    const { root, container } = mounted;
    await act(async () => root.unmount());
    container.remove();
    mounted = null;
  }
  delete (window as { desktopBridge?: unknown }).desktopBridge;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("a thread's Diagnostics link", () => {
  it("downloads the thread's environment's logs over its own connection", async () => {
    const { router, container } = await renderAtThread();

    await click(findByText(container, "Diagnostics"));
    expect(router.state.location.pathname).toBe("/settings/diagnostics");
    expect(router.state.location.search).toEqual({ environment: OMARCHY });

    await click(container.querySelector('button[aria-label="Download diagnostic logs"]'));
    expect(h.environmentCalls).toEqual([{ environmentId: OMARCHY, label: "Omarchy" }]);
    expect(h.primaryCalls).toBe(0);
    expect(h.saved).toEqual(["bibcode-diagnostics-omarchy.zip"]);
  });

  it("keeps a disconnected thread environment chosen and downloads nothing", async () => {
    h.environments = [h.primary!, environment("Omarchy", "disconnected")];
    const { router, container } = await renderAtThread();

    await click(findByText(container, "Diagnostics"));
    expect(router.state.location.search).toEqual({ environment: OMARCHY });
    const download = container.querySelector(
      'button[aria-label="Download diagnostic logs"]',
    ) as HTMLButtonElement;
    expect(download.disabled).toBe(true);
    expect(container.querySelector("[data-status]")?.textContent).toBe(
      "Omarchy is not connected. Reconnect it to download its logs.",
    );
    await click(download);
    expect(h.environmentCalls).toEqual([]);
    expect(h.primaryCalls).toBe(0);
  });
});
