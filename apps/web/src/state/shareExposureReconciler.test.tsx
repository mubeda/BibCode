// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  primaryEnvironmentId: "primary" as string | null,
  revision: 1,
  wslOnly: false,
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

vi.mock("./desktopWslState", () => ({
  desktopWslStateAtom: Symbol.for("desktop-wsl-state"),
}));

vi.mock("./auth", () => ({
  authEnvironment: {
    accessChanges: () => Symbol.for("auth-access-changes"),
  },
}));

vi.mock("./query", () => ({
  useEnvironmentQuery: (atom: unknown) =>
    atom === Symbol.for("desktop-wsl-state")
      ? { data: { wslOnly: h.wslOnly } }
      : { data: atom === null ? null : { revision: h.revision } },
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

import {
  reconcileShareExposureOnce,
  shouldRevertExposure,
  useShareExposureReconciler,
} from "./shareExposureReconciler";

const localExposure = {
  configuredMode: "local-only" as const,
  management: "native" as const,
  mode: "local-only" as const,
  endpointUrl: null,
  advertisedHost: null,
  tailscaleServeEnabled: false,
  tailscaleServePort: 443,
};
const wideExposure = {
  ...localExposure,
  configuredMode: "network-accessible" as const,
  mode: "network-accessible" as const,
  endpointUrl: "http://192.168.1.20:3773",
  advertisedHost: "192.168.1.20",
};

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

describe("reconcileShareExposureOnce", () => {
  const loopbackDesired = {
    desiredExposure: "loopback" as const,
    offHostGrantCount: 0,
    legacyGrantCount: 0,
  };

  beforeEach(() => h.refreshNetwork.mockReset());

  it("narrows a stale wide exposure and confirms the post-apply share state", async () => {
    const getShareState = vi.fn(async () => loopbackDesired);
    const applyExposure = vi.fn(async () => localExposure);

    await expect(
      reconcileShareExposureOnce({
        getShareState,
        getExposureState: async () => wideExposure,
        applyExposure,
        canApplyExposure: () => true,
      }),
    ).resolves.toBe("narrowed");
    expect(getShareState).toHaveBeenCalledTimes(2);
    expect(applyExposure).toHaveBeenCalledExactlyOnceWith("local-only");
    expect(h.refreshNetwork).toHaveBeenCalledOnce();
  });

  it("re-widens when an off-host grant appears during narrowing", async () => {
    const getShareState = vi.fn().mockResolvedValueOnce(loopbackDesired).mockResolvedValueOnce({
      desiredExposure: "wide",
      offHostGrantCount: 1,
      legacyGrantCount: 0,
    });
    const applyExposure = vi.fn(async (desired: "local-only" | "network-accessible") =>
      desired === "local-only" ? localExposure : wideExposure,
    );

    await expect(
      reconcileShareExposureOnce({
        getShareState,
        getExposureState: async () => wideExposure,
        applyExposure,
        canApplyExposure: () => true,
      }),
    ).resolves.toBe("rewidened");
    expect(applyExposure.mock.calls).toEqual([["local-only"], ["network-accessible"]]);
    expect(h.refreshNetwork).toHaveBeenCalledTimes(2);
  });

  it("leaves wide exposure unchanged while a legacy grant blocks narrowing", async () => {
    const applyExposure = vi.fn();
    await expect(
      reconcileShareExposureOnce({
        getShareState: async () => ({ ...loopbackDesired, legacyGrantCount: 1 }),
        getExposureState: async () => wideExposure,
        applyExposure,
        canApplyExposure: () => true,
      }),
    ).resolves.toBe("unchanged");
    expect(applyExposure).not.toHaveBeenCalled();
    expect(h.refreshNetwork).not.toHaveBeenCalled();
  });

  it("restores a local startup to wide only when a live off-host grant requires it", async () => {
    const applyExposure = vi.fn(async () => wideExposure);
    await expect(
      reconcileShareExposureOnce({
        getShareState: async () => ({
          desiredExposure: "wide",
          offHostGrantCount: 1,
          legacyGrantCount: 0,
        }),
        getExposureState: async () => localExposure,
        applyExposure,
        canApplyExposure: () => true,
      }),
    ).resolves.toBe("widened");
    expect(applyExposure).toHaveBeenCalledExactlyOnceWith("network-accessible");
    expect(h.refreshNetwork).toHaveBeenCalledOnce();
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
    h.wslOnly = false;
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
    expect(h.getShareState).toHaveBeenCalledTimes(3);
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

  it("does not run the native exposure state machine for a WSL-only primary", async () => {
    h.wslOnly = true;
    const getServerExposureState = vi.fn(async () => wideExposure);
    const applyServerExposure = vi.fn(async () => localExposure);
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: { getServerExposureState, applyServerExposure },
    });

    await act(async () => {
      root.render(<HookHarness />);
      await Promise.resolve();
    });

    expect(h.getShareState).not.toHaveBeenCalled();
    expect(getServerExposureState).not.toHaveBeenCalled();
    expect(applyServerExposure).not.toHaveBeenCalled();
  });

  it("cancels an in-flight native reconciliation when WSL-only wins the topology lock", async () => {
    let resolveShareState!: (value: {
      desiredExposure: "loopback";
      offHostGrantCount: number;
      legacyGrantCount: number;
    }) => void;
    h.getShareState.mockReturnValue(
      new Promise((resolve) => {
        resolveShareState = resolve;
      }),
    );
    const getServerExposureState = vi.fn(async () => wideExposure);
    const applyServerExposure = vi.fn(async () => localExposure);
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: { getServerExposureState, applyServerExposure },
    });

    await act(async () => {
      root.render(<HookHarness />);
      await Promise.resolve();
    });
    expect(h.getShareState).toHaveBeenCalledOnce();

    h.wslOnly = true;
    await act(async () => {
      root.render(<HookHarness />);
      await Promise.resolve();
    });
    await act(async () => {
      resolveShareState({
        desiredExposure: "loopback",
        offHostGrantCount: 0,
        legacyGrantCount: 0,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(applyServerExposure).not.toHaveBeenCalled();
    expect(h.refreshNetwork).not.toHaveBeenCalled();
    expect(h.toastAdd).not.toHaveBeenCalled();
  });
});
