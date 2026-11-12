import type { HostMetricsView } from "@bibcode/client-runtime/state/server";
import { describe, expect, it } from "vite-plus/test";

import {
  HOST_METRICS_UNSUPPORTED_MESSAGE,
  isServerRestart,
  presentHostDashboard,
  shouldSubscribeToHostMetrics,
} from "./hostDashboard.logic";

const NOW_MS = Date.UTC(2026, 10, 11, 20, 0, 0);
const STARTED_AT = new Date(NOW_MS - (3 * 60 + 5) * 60_000).toISOString();

function view(overrides: Partial<HostMetricsView> = {}): HostMetricsView {
  return {
    bootId: "boot-1",
    startedAt: STARTED_AT,
    statisticsSince: STARTED_AT,
    host: { os: "macos", arch: "aarch64", cpuCount: 12, memoryTotalBytes: 34_359_738_368 },
    sample: {
      sampledAt: new Date(NOW_MS - 1_000).toISOString(),
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
          name: "slow",
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
    recent: [],
    uptime: [],
    ...overrides,
  };
}

const BASE = {
  view: null,
  shownView: null,
  connected: true,
  supported: true,
  failure: null,
  lastItemAtMs: null,
  nowMs: NOW_MS,
} as const;

function allText(value: unknown): string {
  return JSON.stringify(value);
}

describe("shouldSubscribeToHostMetrics", () => {
  it("subscribes only while open, visible, connected and supported", () => {
    const all = { open: true, visible: true, connected: true, supported: true };
    expect(shouldSubscribeToHostMetrics(all)).toBe(true);
    expect(shouldSubscribeToHostMetrics({ ...all, open: false })).toBe(false);
    expect(shouldSubscribeToHostMetrics({ ...all, visible: false })).toBe(false);
    expect(shouldSubscribeToHostMetrics({ ...all, connected: false })).toBe(false);
    expect(shouldSubscribeToHostMetrics({ ...all, supported: false })).toBe(false);
  });
});

describe("isServerRestart", () => {
  it("compares boot IDs, and start times only when a boot ID is missing", () => {
    const later = new Date(NOW_MS).toISOString();
    expect(isServerRestart(view(), view({ bootId: "boot-2" }))).toBe(true);
    expect(isServerRestart(view(), view({ startedAt: later }))).toBe(false);
    expect(isServerRestart(view({ bootId: null }), view({ bootId: null, startedAt: later }))).toBe(
      true,
    );
    expect(isServerRestart(view({ bootId: null }), view({ bootId: null }))).toBe(false);
  });
});

describe("presentHostDashboard", () => {
  it("is loading with skeletons before the first snapshot", () => {
    const presentation = presentHostDashboard(BASE);
    expect(presentation.state).toBe("loading");
    expect(presentation.values).toBeNull();
  });

  it("is live with values when an item arrived a second ago", () => {
    const presentation = presentHostDashboard({
      ...BASE,
      view: view(),
      lastItemAtMs: NOW_MS - 1_000,
    });
    expect(presentation.state).toBe("live");
    expect(presentation.dimmed).toBe(false);
    expect(presentation.notice).toBeNull();
  });

  it("is stale with the age after 3 seconds without an item", () => {
    const presentation = presentHostDashboard({
      ...BASE,
      view: view(),
      lastItemAtMs: NOW_MS - 3_000,
    });
    expect(presentation.state).toBe("stale");
    expect(presentation.dimmed).toBe(true);
    expect(presentation.notice).toBe("Last updated 3 s ago");
  });

  it("keeps the last values dimmed while disconnected, even after a dropped request", () => {
    const presentation = presentHostDashboard({
      ...BASE,
      connected: false,
      supported: false,
      shownView: view(),
      failure: "The connection dropped before the result arrived.",
    });
    expect(presentation.state).toBe("disconnected");
    expect(presentation.dimmed).toBe(true);
    expect(presentation.notice).toBe("Disconnected");
    expect(presentation.values?.cpu).toBe("23.5%");
  });

  it("says when the server restarted", () => {
    const restartedAt = new Date(NOW_MS - 10_000).toISOString();
    const presentation = presentHostDashboard({
      ...BASE,
      shownView: view(),
      view: view({ bootId: "boot-2", startedAt: restartedAt, statisticsSince: restartedAt }),
      lastItemAtMs: NOW_MS,
    });
    expect(presentation.state).toBe("restarted");
    expect(presentation.notice).toMatch(/^Server restarted at \S/);
  });

  it("explains an older server", () => {
    const presentation = presentHostDashboard({ ...BASE, supported: false });
    expect(presentation.state).toBe("unsupported");
    expect(presentation.notice).toBe(
      "This server's version doesn't report host metrics. Update it to see this dashboard.",
    );
    expect(HOST_METRICS_UNSUPPORTED_MESSAGE).toBe(presentation.notice);
  });

  it("is loading while the server's capabilities are still unknown", () => {
    expect(presentHostDashboard({ ...BASE, supported: null }).state).toBe("loading");
  });

  it("shows the failure message", () => {
    const presentation = presentHostDashboard({
      ...BASE,
      shownView: view(),
      failure: "The server refused the request.",
    });
    expect(presentation.state).toBe("error");
    expect(presentation.notice).toBe("The server refused the request.");
  });

  it("formats the populated dashboard without em dashes", () => {
    const presentation = presentHostDashboard({
      ...BASE,
      view: view(),
      lastItemAtMs: NOW_MS,
    });
    const values = presentation.values!;
    expect(values.cpu).toBe("23.5%");
    expect(values.cores).toBe("12 cores");
    expect(values.memory).toBe("11.2 GB of 32.0 GB, 35%");
    expect(values.volumes[0]?.free).toBe("625.0 GB free");
    expect(values.volumes[0]?.badges).toEqual([]);
    expect(values.volumes[1]?.badges).toEqual(["Removable", "Read-only", "Not responding"]);
    expect(values.volumes[1]?.usage).toBeNull();
    expect(values.since).toMatch(/^Since .+ \(up 3h\)$/);
    expect(values.statistics.map((row) => row.label)).toEqual(["CPU", "Memory"]);
    expect(values.statistics[0]?.figures.map((figure) => figure.label)).toEqual([
      "Current",
      "Minimum",
      "Average",
      "p95",
      "Maximum",
    ]);
    expect(values.statistics[0]?.figures[4]?.value).toBe("97.5%");
    for (const presented of [
      presentation,
      presentHostDashboard({ ...BASE, supported: false }),
      presentHostDashboard({ ...BASE, connected: false, shownView: view() }),
      presentHostDashboard({ ...BASE, view: view(), lastItemAtMs: NOW_MS - 5_000 }),
    ]) {
      expect(allText(presented)).not.toContain("—");
    }
  });
});
