import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  UnavailableConnectionTarget,
} from "@bibcode/client-runtime/connection";
import {
  EnvironmentId,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type DesktopBridge,
  type DesktopWslDiscovery,
  type DesktopWslState,
} from "@bibcode/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  DESKTOP_LOCAL_TOPOLOGY_SAFETY_MS,
  createDesktopLocalTopologyController,
  createDesktopSecondaryBootstrapsReader,
  desktopLocalRuntimeId,
  desktopLocalConnectionId,
  isDesktopLocalConnectionTarget,
} from "./desktopLocal";

const discovery = (generation: number, health: DesktopWslDiscovery["health"] = "available") =>
  ({
    generation,
    observedAt: `2026-08-25T00:00:0${generation}Z`,
    health,
    detail: health === "available" ? null : "Discovery failed.",
    distros: [{ name: "Ubuntu", isDefault: true, state: "running", version: 2 }],
  }) satisfies DesktopWslDiscovery;

const wslState = (generation: number): DesktopWslState => ({
  enabled: true,
  distro: null,
  legacyAcceptedDistro: null,
  available: true,
  wslOnly: false,
  distros: discovery(generation).distros,
  discovery: discovery(generation),
  preflightError: null,
});

function createTopologyHost() {
  const focusListeners = new Set<() => void>();
  const intervals = new Map<number, { readonly listener: () => void; readonly delay: number }>();
  let nextInterval = 0;
  return {
    host: {
      addEventListener: (_type: "focus", listener: () => void) => {
        focusListeners.add(listener);
      },
      removeEventListener: (_type: "focus", listener: () => void) => {
        focusListeners.delete(listener);
      },
      setInterval: (listener: () => void, delay: number) => {
        nextInterval += 1;
        intervals.set(nextInterval, { listener, delay });
        return nextInterval;
      },
      clearInterval: (id: unknown) => {
        intervals.delete(id as number);
      },
    },
    fireFocus: () => {
      for (const listener of focusListeners) listener();
    },
    fireSafetyWakeup: () => {
      for (const interval of intervals.values()) interval.listener();
    },
    focusListeners,
    intervals,
  };
}

describe("desktop local connection identity", () => {
  it("preserves the opaque desktop runtime slot", () => {
    const target = new BearerConnectionTarget({
      connectionId: desktopLocalConnectionId("desktop-wsl-runtime:test"),
      environmentId: EnvironmentId.make("environment-wsl"),
      label: "WSL (Ubuntu)",
    });

    expect(isDesktopLocalConnectionTarget(target)).toBe(true);
    expect(desktopLocalRuntimeId(target)).toBe("desktop-wsl-runtime:test");
  });

  it("does not classify the primary environment as desktop-local", () => {
    const target = new PrimaryConnectionTarget({
      environmentId: EnvironmentId.make("environment-primary"),
      httpBaseUrl: "http://127.0.0.1:3773",
      label: "This device",
      wsBaseUrl: "ws://127.0.0.1:3773",
    });

    expect(isDesktopLocalConnectionTarget(target)).toBe(false);
    expect(desktopLocalRuntimeId(target)).toBeNull();
  });

  it("keeps an unavailable desired WSL environment desktop-local", () => {
    const target = new UnavailableConnectionTarget({
      connectionId: desktopLocalConnectionId("desktop-wsl-runtime:test"),
      environmentId: EnvironmentId.make("environment-wsl"),
      label: "WSL (Ubuntu)",
      configuredDistro: "Ubuntu",
      detail: "the configured WSL distribution could not start",
    });

    expect(isDesktopLocalConnectionTarget(target)).toBe(true);
    expect(desktopLocalRuntimeId(target)).toBe("desktop-wsl-runtime:test");
  });
});

describe("desktop local topology reads", () => {
  it("distinguishes a successful empty topology from a read failure", () => {
    let readBootstraps = () => [];
    const reader = createDesktopSecondaryBootstrapsReader(() => ({
      getLocalEnvironmentBootstraps: () => readBootstraps(),
    }));

    expect(reader.readResult()).toEqual({ _tag: "Success", bootstraps: [] });

    const cause = new Error("IPC unavailable");
    readBootstraps = () => {
      throw cause;
    };
    expect(reader.readResult()).toEqual({ _tag: "Failure", cause });
  });

  it("filters the primary bootstrap from successful topology reads", () => {
    const secondary = {
      id: "desktop-wsl-runtime:test",
      label: "WSL: Ubuntu",
      httpBaseUrl: "http://127.0.0.1:4000",
      wsBaseUrl: "ws://127.0.0.1:4000",
    };

    const reader = createDesktopSecondaryBootstrapsReader(() => ({
      getLocalEnvironmentBootstraps: () => [
        {
          ...secondary,
          id: PRIMARY_LOCAL_ENVIRONMENT_ID,
          label: "Windows",
        },
        secondary,
      ],
    }));

    expect(reader.readResult()).toEqual({ _tag: "Success", bootstraps: [secondary] });
  });

  it("retains the last successful snapshot only until another read succeeds", () => {
    const secondary = {
      id: "desktop-wsl-runtime:test",
      label: "WSL: Ubuntu",
      httpBaseUrl: "http://127.0.0.1:4000",
      wsBaseUrl: "ws://127.0.0.1:4000",
    };
    let readBootstraps = () => [secondary];
    const reader = createDesktopSecondaryBootstrapsReader(() => ({
      getLocalEnvironmentBootstraps: () => readBootstraps(),
    }));

    const connectedSnapshot = reader.readSnapshot();
    expect(connectedSnapshot).toEqual([secondary]);

    readBootstraps = () => {
      throw new Error("IPC unavailable");
    };
    expect(reader.readSnapshot()).toBe(connectedSnapshot);

    readBootstraps = () => [];
    const removedSnapshot = reader.readSnapshot();
    expect(removedSnapshot).toEqual([]);

    readBootstraps = () => {
      throw new Error("IPC unavailable again");
    };
    expect(reader.readSnapshot()).toBe(removedSnapshot);
  });
});

describe("desktop local event topology", () => {
  it("performs one initial read and coalesces focus, manual, and safety refreshes", async () => {
    const topologyHost = createTopologyHost();
    const getLocalEnvironmentBootstraps = vi.fn(() => []);
    const getWslState = vi.fn(async () => wslState(1));
    let resolveRefresh: ((state: DesktopWslState) => void) | undefined;
    const refreshWslDiscovery = vi.fn(
      () =>
        new Promise<DesktopWslState>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    let emitDiscovery: ((event: DesktopWslDiscovery) => void) | undefined;
    const disposeDiscovery = vi.fn();
    const disposeBootstraps = vi.fn();
    const bridge = {
      getLocalEnvironmentBootstraps,
      getWslState,
      refreshWslDiscovery,
      onWslDiscoveryChanged: (listener: (event: DesktopWslDiscovery) => void) => {
        emitDiscovery = listener;
        return disposeDiscovery;
      },
      onLocalEnvironmentBootstrapsChanged: () => disposeBootstraps,
    } as Pick<
      DesktopBridge,
      | "getLocalEnvironmentBootstraps"
      | "getWslState"
      | "refreshWslDiscovery"
      | "onWslDiscoveryChanged"
      | "onLocalEnvironmentBootstrapsChanged"
    >;
    const controller = createDesktopLocalTopologyController({
      resolveBridge: () => bridge,
      host: topologyHost.host,
    });
    const observed: DesktopWslState[] = [];
    const unsubscribe = controller.subscribe((snapshot) => {
      if (snapshot.wslState !== null) observed.push(snapshot.wslState);
    });
    await Promise.resolve();

    expect(getLocalEnvironmentBootstraps).toHaveBeenCalledTimes(1);
    expect(getWslState).toHaveBeenCalledTimes(1);
    expect(topologyHost.intervals.size).toBe(1);
    expect([...topologyHost.intervals.values()][0]?.delay).toBe(DESKTOP_LOCAL_TOPOLOGY_SAFETY_MS);
    expect([...topologyHost.intervals.values()][0]?.delay).not.toBe(3_000);

    topologyHost.fireFocus();
    topologyHost.fireFocus();
    await Promise.resolve();
    expect(getLocalEnvironmentBootstraps).toHaveBeenCalledTimes(2);
    const manual = controller.refresh();
    topologyHost.fireSafetyWakeup();
    expect(refreshWslDiscovery).toHaveBeenCalledTimes(1);
    resolveRefresh?.(wslState(2));
    await manual;
    expect(controller.getSnapshot().wslState?.discovery.generation).toBe(2);

    emitDiscovery?.(discovery(1));
    expect(controller.getSnapshot().wslState?.discovery.generation).toBe(2);
    expect(observed.at(-1)?.discovery.generation).toBe(2);

    unsubscribe();
    expect(disposeDiscovery).toHaveBeenCalledTimes(1);
    expect(disposeBootstraps).toHaveBeenCalledTimes(1);
    expect(topologyHost.focusListeners.size).toBe(0);
    expect(topologyHost.intervals.size).toBe(0);
  });

  it("retains the last successful bootstrap snapshot after discovery read failure", async () => {
    const topologyHost = createTopologyHost();
    const secondary = {
      id: "desktop-wsl-runtime:test",
      label: "WSL: Ubuntu",
      httpBaseUrl: "http://127.0.0.1:4000",
      wsBaseUrl: "ws://127.0.0.1:4000",
    };
    let failBootstrapRead = false;
    let emitDiscovery: ((event: DesktopWslDiscovery) => void) | undefined;
    const bridge = {
      getLocalEnvironmentBootstraps: () => {
        if (failBootstrapRead) throw new Error("IPC unavailable");
        return [secondary];
      },
      getWslState: async () => wslState(1),
      onWslDiscoveryChanged: (listener: (event: DesktopWslDiscovery) => void) => {
        emitDiscovery = listener;
        return () => undefined;
      },
    } as Pick<
      DesktopBridge,
      "getLocalEnvironmentBootstraps" | "getWslState" | "onWslDiscoveryChanged"
    >;
    const controller = createDesktopLocalTopologyController({
      resolveBridge: () => bridge,
      host: topologyHost.host,
    });
    const unsubscribe = controller.subscribe(() => undefined);
    await Promise.resolve();
    expect(controller.getSnapshot().secondaryBootstraps).toEqual({
      _tag: "Success",
      bootstraps: [secondary],
    });

    failBootstrapRead = true;
    emitDiscovery?.(discovery(2, "failed"));
    expect(controller.getSnapshot().secondaryBootstraps).toEqual({
      _tag: "Failure",
      cause: expect.any(Error),
      retainedBootstraps: [secondary],
    });
    expect(controller.getSnapshot().wslState?.discovery.generation).toBe(2);
    unsubscribe();
  });

  it("ignores late initial state after the final subscriber unmounts", async () => {
    const topologyHost = createTopologyHost();
    let resolveInitial: ((state: DesktopWslState) => void) | undefined;
    const disposeDiscovery = vi.fn();
    const bridge = {
      getLocalEnvironmentBootstraps: () => [],
      getWslState: () =>
        new Promise<DesktopWslState>((resolve) => {
          resolveInitial = resolve;
        }),
      onWslDiscoveryChanged: () => disposeDiscovery,
    } as Pick<
      DesktopBridge,
      "getLocalEnvironmentBootstraps" | "getWslState" | "onWslDiscoveryChanged"
    >;
    const controller = createDesktopLocalTopologyController({
      resolveBridge: () => bridge,
      host: topologyHost.host,
    });
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    const callsBeforeUnmount = listener.mock.calls.length;
    unsubscribe();
    resolveInitial?.(wslState(1));
    await Promise.resolve();

    expect(listener).toHaveBeenCalledTimes(callsBeforeUnmount);
    expect(disposeDiscovery).toHaveBeenCalledTimes(1);
    expect(topologyHost.intervals.size).toBe(0);
  });
});
