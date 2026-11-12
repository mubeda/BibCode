// @vitest-environment happy-dom
import type { HostMetricsView } from "@bibcode/client-runtime/state/server";
import { EnvironmentId } from "@bibcode/contracts";
import { act, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  data: null as unknown,
  error: null as string | null,
  /** Every atom the sheet passed to `useEnvironmentQuery`, null when it did not subscribe. */
  queries: [] as unknown[],
  refresh: vi.fn(),
  navigate: vi.fn(),
  visibility: "visible" as DocumentVisibilityState,
  environment: null as unknown,
}));

vi.mock("../ui/sheet", () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Sheet: Box,
    SheetPopup: ({ children, ...props }: { children?: ReactNode }) => (
      <div data-testid={(props as { "data-testid"?: string })["data-testid"]}>{children}</div>
    ),
    SheetHeader: Box,
    SheetTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
    SheetDescription: Box,
    SheetPanel: Box,
  };
});
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: ReactElement }) => render,
  TooltipPopup: () => null,
}));
vi.mock("~/hooks/useSettings", () => ({ useClientSettings: () => "locale" }));
vi.mock("~/state/environments", () => ({ useEnvironment: () => h.environment }));
vi.mock("~/state/server", () => ({
  serverEnvironment: { hostMetrics: (key: unknown) => ({ hostMetrics: key }) },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => {
    h.queries.push(atom);
    return {
      data: atom === null ? null : h.data,
      error: atom === null ? null : h.error,
      isPending: atom !== null && h.data === null && h.error === null,
      refresh: h.refresh,
    };
  },
}));

import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/reactivity";

import { hostDashboardRequest } from "~/state/hostDashboard";
import { HostDashboardCoordinator, HostDashboardSheet } from "./HostDashboardSheet";

const ENVIRONMENT_ID = EnvironmentId.make("example-server");

function environment(input: { phase?: string; hostMetrics?: boolean | undefined } = {}) {
  const capabilities = input.hostMetrics === undefined ? {} : { hostMetrics: input.hostMetrics };
  return {
    environmentId: ENVIRONMENT_ID,
    label: "example-server",
    connection: { phase: input.phase ?? "connected", error: null, traceId: null },
    serverConfig: { environment: { capabilities } },
  };
}

function view(overrides: Partial<HostMetricsView> = {}): HostMetricsView {
  const startedAt = new Date(Date.now() - (3 * 60 + 5) * 60_000).toISOString();
  return {
    bootId: "boot-1",
    startedAt,
    statisticsSince: startedAt,
    host: { os: "macos", arch: "aarch64", cpuCount: 12, memoryTotalBytes: 34_359_738_368 },
    sample: {
      sampledAt: new Date(Date.now() - 1_000).toISOString(),
      cpuPercent: 23.5,
      memoryTotalBytes: 34_359_738_368,
      memoryUsedBytes: 12_025_908_428,
      memoryAvailableBytes: 34_359_738_368 - 12_025_908_428,
      volumes: [
        {
          mountPoint: "/",
          name: "System",
          fileSystem: "apfs",
          totalBytes: 2_147_483_648_000,
          freeBytes: 671_088_640_000,
          usedBytes: 2_147_483_648_000 - 671_088_640_000,
          removable: false,
          readOnly: false,
          state: "ok",
        },
        {
          mountPoint: "/mnt/slow",
          name: "",
          fileSystem: "ext4",
          totalBytes: null,
          freeBytes: null,
          usedBytes: null,
          removable: true,
          readOnly: true,
          state: "notResponding",
        },
      ],
      volumesPaused: false,
    },
    cpu: { current: 23.5, minimum: 2, average: 11.25, p95: 40, maximum: 97.5 },
    memory: { current: 35, minimum: 30, average: 33, p95: 36, maximum: 40 },
    recent: [
      { sampledAt: new Date(Date.now() - 2_000).toISOString(), cpuPercent: 20, memoryPercent: 34 },
      {
        sampledAt: new Date(Date.now() - 1_000).toISOString(),
        cpuPercent: 23.5,
        memoryPercent: 35,
      },
    ],
    uptime: [
      {
        startedAt: new Date(Date.now() - 120_000).toISOString(),
        durationMs: 60_000,
        cpuAverage: 10,
        cpuPeak: 40,
        memoryAverage: 33,
        memoryPeak: 36,
      },
    ],
    hiddenVolumes: [],
    volumeStatistics: [],
    ...overrides,
  };
}

const roots: ReturnType<typeof createRoot>[] = [];
let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  Object.assign(h, {
    data: null,
    error: null,
    queries: [],
    visibility: "visible",
    environment: environment({ hostMetrics: true }),
  });
  h.refresh.mockReset();
  h.navigate.mockReset();
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => h.visibility,
  });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const mounted of roots.splice(0)) await act(async () => mounted.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
});

async function render(onClose = vi.fn()) {
  if (root === null || container === null || !document.body.contains(container)) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    roots.push(root);
  }
  const target = root;
  await act(async () =>
    target.render(
      <HostDashboardSheet
        environmentId={ENVIRONMENT_ID}
        onClose={onClose}
        onOpenRemoteServers={h.navigate}
      />,
    ),
  );
  return { container: container!, onClose };
}

function text(): string {
  return container?.textContent ?? "";
}

function subscribed(): boolean {
  return h.queries.at(-1) !== null && h.queries.at(-1) !== undefined;
}

afterEach(() => {
  root = null;
  container = null;
});

describe("HostDashboardSheet", () => {
  it("shows skeletons until the first snapshot", async () => {
    await render();
    expect(container?.querySelector('[data-slot="skeleton"]')).not.toBeNull();
    expect(subscribed()).toBe(true);
    expect(text()).toContain("example-server");
  });

  it("shows the populated dashboard", async () => {
    h.data = view();
    await render();
    expect(text()).not.toContain("—");
    const cpu = container!.querySelector('[data-testid="host-dashboard-cpu"]');
    expect(cpu?.textContent).toContain("23.5%");
    expect(cpu?.getAttribute("data-sampled-at")).toBe(
      (h.data as HostMetricsView).sample?.sampledAt,
    );
    expect(text()).toContain("12 cores");
    expect(
      container!.querySelector('[data-testid="host-dashboard-memory"]')?.textContent,
    ).toContain("11.2 GB of 32.0 GB, 35%");
    const volumes = [...container!.querySelectorAll('[data-testid="host-dashboard-volume"]')];
    expect(volumes).toHaveLength(2);
    expect(volumes[0]?.textContent).toContain("/");
    expect(volumes[0]?.textContent).toContain("625.0 GB free");
    expect(volumes[1]?.textContent).toContain("Removable");
    expect(volumes[1]?.textContent).toContain("Read-only");
    expect(volumes[1]?.textContent).toContain("Not responding");
    const since = container!.querySelector('[data-testid="host-dashboard-since"]');
    expect(since?.textContent).toMatch(/Since .+\(up 3h\)/);
    for (const label of ["Current", "Minimum", "Average", "p95", "Maximum"]) {
      expect(since?.textContent).toContain(label);
    }
    expect(since?.textContent).toContain("97.5%");
    expect(since?.textContent).toContain("40.0%");
    expect(since?.querySelector('[aria-label="CPU since start"]')?.children.length).toBe(1);
    expect(since?.querySelector('[aria-label="Memory since start"]')?.children.length).toBe(1);
  });

  it("lists hidden volumes with their reason under a closed disclosure", async () => {
    h.data = view({
      hiddenVolumes: [
        { mountPoint: "/mnt/share", fileSystem: "nfs4", reason: "network" },
        { mountPoint: "/run/overlay", fileSystem: "overlay", reason: "overlay" },
        { mountPoint: "/etc/hostname", fileSystem: "ext4", reason: "fileMount" },
        { mountPoint: "/mnt/empty", fileSystem: "tmpfs", reason: "empty" },
        {
          mountPoint: "/System/Volumes/Data",
          fileSystem: "apfs",
          reason: "sameStorage",
          sameStorageAs: "/",
        },
        { mountPoint: "/mnt/future", fileSystem: "ext4", reason: "someNewReason" },
      ],
    });
    await render();
    const toggle = [...container!.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Hidden volumes (6)"),
    );
    expect(toggle).toBeDefined();
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(text()).not.toContain("/mnt/share");
    await act(async () => toggle!.click());
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    const rows = [...container!.querySelectorAll('[data-testid="host-dashboard-hidden-volume"]')];
    expect(rows.map((row) => row.textContent)).toEqual([
      "/mnt/shareNetwork volume",
      "/run/overlayContainer layer",
      "/etc/hostnameFile mount",
      "/mnt/emptyEmpty",
      "/System/Volumes/DataSame storage as /",
      "/mnt/futureHidden by the volume filter",
    ]);
    // Hidden volumes are listed, never sized.
    expect(rows.some((row) => /free|\bof\b|GB/u.test(row.textContent ?? ""))).toBe(false);
  });

  it("shows each volume's used percent since start in the Since section", async () => {
    h.data = view({
      volumeStatistics: [
        {
          mountPoint: "/",
          statistic: { current: 60, minimum: 40, average: 50, p95: 59, maximum: 60 },
        },
      ],
    });
    await render();
    const since = container!.querySelector('[data-testid="host-dashboard-since"]');
    const rows = [...since!.querySelectorAll("tbody tr")].map((row) => row.textContent);
    expect(rows).toEqual([
      expect.stringContaining("CPU"),
      expect.stringContaining("Memory"),
      "/ used60.0%40.0%50.0%59.0%60.0%",
    ]);
  });

  it("shows no hidden volumes disclosure when nothing is hidden", async () => {
    h.data = view();
    await render();
    expect(text()).not.toContain("Hidden volumes");
  });

  it("says the volume list is not answering only when the server reports it", async () => {
    const withFlag = (flag: boolean | undefined) => {
      const base = view() as HostMetricsView;
      return {
        ...base,
        sample: {
          ...base.sample!,
          ...(flag === undefined ? {} : { volumeListingNotResponding: flag }),
        },
      } as HostMetricsView;
    };
    const notice =
      "The volume list is not answering. Volumes shown are from the last list that did.";
    h.data = withFlag(true);
    await render();
    expect(text()).toContain(notice);
    for (const flag of [false, undefined]) {
      h.data = withFlag(flag);
      await render();
      expect(text()).not.toContain(notice);
    }
  });

  it("dims the values after 3 seconds without an item", async () => {
    vi.useFakeTimers({
      now: Date.UTC(2026, 10, 11, 20, 0, 0),
      toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"],
    });
    h.data = view();
    await render();
    expect(text()).not.toContain("Last updated");
    await act(async () => vi.advanceTimersByTime(3_000));
    expect(text()).toContain("Last updated 3 s ago");
    expect(text()).toContain("23.5%");
  });

  it("keeps the last values dimmed while disconnected and subscribes again after", async () => {
    h.data = view();
    await render();
    h.environment = environment({ phase: "reconnecting", hostMetrics: true });
    await render();
    expect(subscribed()).toBe(false);
    expect(text()).toContain("Disconnected");
    expect(text()).toContain("23.5%");
    h.environment = environment({ hostMetrics: true });
    await render();
    expect(subscribed()).toBe(true);
    expect(text()).not.toContain("Disconnected");
  });

  it("says the server restarted when a new snapshot has another boot ID", async () => {
    h.data = view();
    await render();
    h.environment = environment({ phase: "reconnecting", hostMetrics: true });
    await render();
    h.environment = environment({ hostMetrics: true });
    h.data = view({
      bootId: "boot-2",
      cpu: { current: 5, minimum: 5, average: 5, p95: 5, maximum: 5 },
    });
    await render();
    expect(text()).toContain("Server restarted at");
    expect(
      container!.querySelector('[data-testid="host-dashboard-since"]')?.textContent,
    ).not.toContain("97.5%");
  });

  it("shows the failure with Retry, which subscribes again", async () => {
    h.error = "The server refused the request.";
    await render();
    expect(text()).toContain("The server refused the request.");
    expect(container?.querySelector('[data-slot="skeleton"]')).toBeNull();
    const retry = [...container!.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry",
    );
    expect(retry).toBeDefined();
    await act(async () => retry!.click());
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it("does not flash a stale age for the snapshot after the document was hidden", async () => {
    vi.useFakeTimers({
      now: Date.UTC(2026, 10, 11, 20, 0, 0),
      toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"],
    });
    h.data = view();
    await render();
    h.visibility = "hidden";
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => vi.advanceTimersByTime(60_000));
    h.data = null;
    h.visibility = "visible";
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => vi.advanceTimersByTime(0));
    h.data = view({ bootId: "boot-1" });
    await render();
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(text()).not.toContain("Last updated");
  });

  it("never asks an older server and points to Remote Servers", async () => {
    h.environment = environment({ hostMetrics: false });
    await render();
    expect(h.queries.length).toBeGreaterThan(0);
    expect(h.queries.every((query) => query === null)).toBe(true);
    expect(text()).toContain(
      "This server's version doesn't report host metrics. Update it to see this dashboard.",
    );
    const open = [...container!.querySelectorAll("button")].find(
      (button) => button.textContent === "Open Remote Servers",
    );
    await act(async () => open!.click());
    expect(h.navigate).toHaveBeenCalledTimes(1);
  });

  it("closes the stream while the document is hidden, not when the window loses focus", async () => {
    h.data = view();
    await render();
    expect(subscribed()).toBe(true);
    await act(async () => window.dispatchEvent(new Event("blur")));
    expect(subscribed()).toBe(true);
    h.visibility = "hidden";
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(subscribed()).toBe(false);
    h.visibility = "visible";
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(subscribed()).toBe(true);
  });

  it("opens from the request atom and unmounts when it is cleared", async () => {
    h.data = view();
    const registry = AtomRegistry.make();
    const host = document.createElement("div");
    document.body.append(host);
    const mounted = createRoot(host);
    roots.push(mounted);
    await act(async () =>
      mounted.render(
        <RegistryContext.Provider value={registry}>
          <HostDashboardCoordinator onOpenRemoteServers={h.navigate} />
        </RegistryContext.Provider>,
      ),
    );
    expect(host.textContent).toBe("");
    expect(h.queries).toEqual([]);
    await act(async () => registry.set(hostDashboardRequest, { environmentId: ENVIRONMENT_ID }));
    expect(host.querySelector('[data-testid="host-dashboard"]')).not.toBeNull();
    expect(subscribed()).toBe(true);
    const before = h.queries.length;
    await act(async () => registry.set(hostDashboardRequest, null));
    expect(host.querySelector('[data-testid="host-dashboard"]')).toBeNull();
    expect(h.queries.length).toBe(before);
  });
});
