// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  summary: {
    statuses: [] as Array<{ environmentId: string; status: string }>,
  },
  projectDataStatuses: [] as Array<{ environmentId: string; status: string }>,
  projectDataStatusListener: null as ((event: { readonly environmentId: string }) => void) | null,
  disposeProjectDataStatus: vi.fn(),
  open: vi.fn(async () => undefined),
  snapshot: {
    open: false,
    trigger: "manual" as const,
    environmentId: null,
    selected: null,
    statuses: [],
    busy: false,
    error: null,
    lastResult: null,
    requiresStorageAdoption: false,
  },
}));

vi.mock("./state/projectDataSafety", () => ({
  projectDataSafetyStore: {
    open: h.open,
    close: vi.fn(),
    refresh: vi.fn(async () => undefined),
    restore: vi.fn(),
    startEmpty: vi.fn(),
    openPath: vi.fn(),
    exportDiagnostics: vi.fn(),
  },
  useProjectDataSafetySnapshot: () => h.snapshot,
}));
vi.mock("./state/shell", () => ({
  environmentAvailabilityCommands: { retry: {}, adoptStorage: {} },
  useEnvironmentShellSummary: () => h.summary,
}));
vi.mock("./state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn(async () => undefined),
}));
vi.mock("./state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      {
        environmentId: "primary",
        entry: { target: { _tag: "PrimaryConnectionTarget" } },
      },
    ],
  }),
}));
vi.mock("./components/desktop/ProjectDataRecoveryDialog", () => ({
  ProjectDataRecoveryDialog: () => null,
}));

import { ProjectDataRecoveryCoordinator } from "./AppRoot";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.summary.statuses = [];
  h.projectDataStatuses = [];
  h.projectDataStatusListener = null;
  h.disposeProjectDataStatus.mockClear();
  h.open.mockClear();
  window.desktopBridge = {
    getProjectDataStatuses: vi.fn(async () => h.projectDataStatuses),
    onProjectDataStatusChanged: vi.fn((listener) => {
      h.projectDataStatusListener = listener;
      return h.disposeProjectDataStatus;
    }),
  } as never;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  delete window.desktopBridge;
  container.remove();
});

describe("ProjectDataRecoveryCoordinator", () => {
  const inspect = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  it("opens recovery when a desktop startup failure was recorded before mount", async () => {
    h.projectDataStatuses = [{ environmentId: "primary", status: "recovery-required" }];

    await act(async () => {
      root.render(<ProjectDataRecoveryCoordinator />);
      await inspect();
    });

    expect(h.open).toHaveBeenCalledWith("primary", "automatic");
  });

  it("re-inspects after desktop invalidation and opens one recovery dialog per episode", async () => {
    h.projectDataStatuses = [{ environmentId: "primary", status: "healthy" }];
    await act(async () => {
      root.render(<ProjectDataRecoveryCoordinator />);
      await inspect();
    });
    expect(h.open).not.toHaveBeenCalled();

    h.projectDataStatuses = [{ environmentId: "primary", status: "recovery-required" }];
    await act(async () => {
      h.projectDataStatusListener?.({ environmentId: "primary" });
      await inspect();
    });
    expect(h.open).toHaveBeenCalledTimes(1);
    expect(h.open).toHaveBeenCalledWith("primary", "automatic");

    await act(async () => {
      h.projectDataStatusListener?.({ environmentId: "primary" });
      await inspect();
    });
    expect(h.open).toHaveBeenCalledTimes(1);

    h.projectDataStatuses = [{ environmentId: "primary", status: "healthy" }];
    await act(async () => {
      h.projectDataStatusListener?.({ environmentId: "primary" });
      await inspect();
    });
    h.projectDataStatuses = [{ environmentId: "primary", status: "recovery-required" }];
    await act(async () => {
      h.projectDataStatusListener?.({ environmentId: "primary" });
      await inspect();
    });
    expect(h.open).toHaveBeenCalledTimes(2);
  });

  it("does not open from healthy or unavailable desktop project data", async () => {
    h.projectDataStatuses = [
      { environmentId: "primary", status: "healthy" },
      { environmentId: "wsl:Ubuntu", status: "unavailable" },
    ];

    await act(async () => {
      root.render(<ProjectDataRecoveryCoordinator />);
      await inspect();
    });

    expect(h.open).not.toHaveBeenCalled();
  });

  it("disposes the desktop invalidation listener on unmount", async () => {
    await act(async () => {
      root.render(<ProjectDataRecoveryCoordinator />);
      await inspect();
    });

    await act(async () => root.unmount());
    expect(h.disposeProjectDataStatus).toHaveBeenCalledTimes(1);
    root = createRoot(container);
  });

  it("automatically opens once for each recovery-required episode", async () => {
    h.summary.statuses = [{ environmentId: "primary", status: "recovery-required" }];
    await act(async () => root.render(<ProjectDataRecoveryCoordinator />));
    expect(h.open).toHaveBeenCalledWith("primary", "automatic");

    await act(async () => root.render(<ProjectDataRecoveryCoordinator />));
    expect(h.open).toHaveBeenCalledTimes(1);

    h.summary.statuses = [{ environmentId: "primary", status: "live" }];
    await act(async () => root.render(<ProjectDataRecoveryCoordinator />));
    h.summary.statuses = [{ environmentId: "primary", status: "recovery-required" }];
    await act(async () => root.render(<ProjectDataRecoveryCoordinator />));
    expect(h.open).toHaveBeenCalledTimes(2);
  });

  it("does not expose privileged recovery for remote blocked environments", async () => {
    h.summary.statuses = [{ environmentId: "remote", status: "recovery-required" }];
    await act(async () => root.render(<ProjectDataRecoveryCoordinator />));
    expect(h.open).not.toHaveBeenCalled();
  });
});
