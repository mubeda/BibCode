// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  primaryEnvironmentId: "primary" as string | null,
  revision: 1,
  getShareState: vi.fn(),
  toastAdd: vi.fn(),
  refreshNetwork: vi.fn(),
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => h.primaryEnvironmentId,
}));

vi.mock("./primaryEnvironment", () => ({
  primaryEnvironmentIdAtom: Symbol.for("primary-environment-id"),
}));

vi.mock("./auth", () => ({
  authEnvironment: {
    accessChanges: () => Symbol.for("auth-access-changes"),
  },
}));

vi.mock("./query", () => ({
  useEnvironmentQuery: (atom: unknown) => ({
    data: atom === null ? null : { revision: h.revision },
  }),
}));

vi.mock("../environments/primary", () => ({
  getServerShareState: h.getShareState,
}));

vi.mock("../components/ui/toast", () => ({
  toastManager: { add: h.toastAdd },
}));

vi.mock("./desktopNetworkAccess", () => ({
  refreshDesktopNetworkAccessState: h.refreshNetwork,
}));

import { shouldRevertExposure, useShareExposureReconciler } from "./shareExposureReconciler";

describe("shouldRevertExposure", () => {
  const loopbackDesired = {
    desiredExposure: "loopback",
    offHostGrantCount: 0,
    legacyGrantCount: 0,
  } as const;

  it("reverts a wide bind with no off-host and no legacy grants", () => {
    expect(
      shouldRevertExposure({
        shareState: loopbackDesired,
        exposureMode: "network-accessible",
      }),
    ).toBe(true);
  });

  it("never reverts while legacy grants exist", () => {
    expect(
      shouldRevertExposure({
        shareState: { ...loopbackDesired, legacyGrantCount: 1 },
        exposureMode: "network-accessible",
      }),
    ).toBe(false);
  });

  it("never acts on a loopback bind or a wide-desired state", () => {
    expect(shouldRevertExposure({ shareState: loopbackDesired, exposureMode: "local-only" })).toBe(
      false,
    );
    expect(
      shouldRevertExposure({
        shareState: { desiredExposure: "wide", offHostGrantCount: 1, legacyGrantCount: 0 },
        exposureMode: "network-accessible",
      }),
    ).toBe(false);
  });
});

function HookHarness() {
  useShareExposureReconciler();
  return null;
}

describe("useShareExposureReconciler", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    h.primaryEnvironmentId = "primary";
    h.revision = 1;
    h.getShareState.mockReset().mockResolvedValue({
      desiredExposure: "loopback",
      offHostGrantCount: 0,
      legacyGrantCount: 0,
    });
    h.toastAdd.mockReset();
    h.refreshNetwork.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("checks startup and narrows once when an auth revision leaves no off-host grants", async () => {
    const getServerExposureState = vi
      .fn()
      .mockResolvedValueOnce({ mode: "local-only" })
      .mockResolvedValueOnce({ mode: "network-accessible" });
    const applyServerExposure = vi.fn(async () => ({ mode: "local-only" }));
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: { getServerExposureState, applyServerExposure },
    });

    await act(async () => {
      root.render(<HookHarness />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(h.getShareState).toHaveBeenCalledOnce();
    expect(applyServerExposure).not.toHaveBeenCalled();

    h.revision = 2;
    await act(async () => {
      root.render(<HookHarness />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(h.getShareState).toHaveBeenCalledTimes(2);
    expect(applyServerExposure).toHaveBeenCalledExactlyOnceWith("local-only");
    expect(h.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ type: "info", title: "Remote access switched off" }),
    );
    expect(h.refreshNetwork).toHaveBeenCalledOnce();
  });

  it("does nothing when the desktop exposure bridge is absent", async () => {
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: undefined,
    });
    await act(async () => {
      root.render(<HookHarness />);
      await Promise.resolve();
    });
    expect(h.getShareState).not.toHaveBeenCalled();
    expect(h.toastAdd).not.toHaveBeenCalled();
  });
});
