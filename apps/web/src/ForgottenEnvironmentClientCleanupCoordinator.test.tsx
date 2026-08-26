// @vitest-environment happy-dom

import { EnvironmentId } from "@bibcode/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  isReady: true,
  reconcile: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("./state/environments", () => ({
  useEnvironments: () => ({
    isReady: h.isReady,
    catalogEnvironmentIds: [EnvironmentId.make("environment-active")],
  }),
}));

vi.mock("./connection/catalog", () => ({
  reconcileForgottenEnvironmentClientCleanup: h.reconcile,
}));

vi.mock("./components/ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: { add: h.toast },
}));

import { ForgottenEnvironmentClientCleanupCoordinator } from "./ForgottenEnvironmentClientCleanupCoordinator";

describe("ForgottenEnvironmentClientCleanupCoordinator", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    h.isReady = true;
    h.reconcile.mockReset().mockResolvedValue({
      repairedEnvironmentIds: [],
      incompleteEnvironmentIds: [EnvironmentId.make("environment-forgotten")],
      storageError: false,
    });
    h.toast.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("warns after the authoritative catalog is ready when repair remains incomplete", async () => {
    await act(async () => root.render(<ForgottenEnvironmentClientCleanupCoordinator />));

    expect(h.reconcile).toHaveBeenCalledOnce();
    expect(h.reconcile.mock.calls[0]?.[1]).toEqual(
      new Set([EnvironmentId.make("environment-active")]),
    );
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warning",
        title: "Private metadata cleanup needs attention",
      }),
    );
  });
});
