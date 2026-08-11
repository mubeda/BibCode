// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  summary: {
    statuses: [] as Array<{ environmentId: string; status: string }>,
  },
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
  h.open.mockClear();
  window.desktopBridge = { getProjectDataStatuses: vi.fn() } as never;
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
