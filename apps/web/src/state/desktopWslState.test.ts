import { DesktopWslBinding } from "@bibcode/client-runtime/connection";
import {
  EnvironmentId,
  type DesktopWslDiscovery,
  type DesktopWslState,
  type ExecutionEnvironmentDescriptor,
} from "@bibcode/contracts";
import * as Cause from "effect/Cause";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { reconcileDesktopWslBindings } from "../connection/desktopLocal";
import { createDesktopWslStateAtom } from "./desktopWslState";

const environmentId = EnvironmentId.make("018f1f52-0d78-7d73-8dc8-7bd50db6f001");
const otherEnvironmentId = EnvironmentId.make("018f1f52-0d78-7d73-8dc8-7bd50db6f002");
const storageInstanceId = "018f1f52-0d78-7d73-8dc8-7bd50db6f101";
const otherStorageInstanceId = "018f1f52-0d78-7d73-8dc8-7bd50db6f102";
const observedAt = "2026-08-25T00:00:00.000Z";

function descriptor(
  id: EnvironmentId = environmentId,
  storageId = storageInstanceId,
): ExecutionEnvironmentDescriptor {
  return {
    environmentId: id,
    label: "Ubuntu",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "0.1.0",
    storageInstanceId: storageId,
    protocol: { minimum: 1, maximum: 1 },
    capabilities: {
      repositoryIdentity: true,
      worktreeCatalog: true,
      worktreeCatalogRefreshReason: true,
      vcsStatusSummary: true,
      activityProtocolVersion: 2,
    },
    transport: { mode: "loopback-http" },
  };
}

function discovery(
  generation: number,
  distros: DesktopWslDiscovery["distros"],
  health: DesktopWslDiscovery["health"] = "available",
): DesktopWslDiscovery {
  return {
    generation,
    observedAt,
    health,
    detail: health === "available" ? null : "Discovery unavailable.",
    distros,
  };
}

function distro(name: string, state: "running" | "stopped" = "running") {
  return { name, state, isDefault: false, version: 2 as const };
}

function binding(overrides: Partial<DesktopWslBinding> = {}): DesktopWslBinding {
  return new DesktopWslBinding({
    bindingId: "binding-ubuntu",
    distroName: "Ubuntu",
    acceptedEnvironmentId: environmentId,
    acceptedStorageInstanceIds: [storageInstanceId],
    acceptedAt: observedAt,
    lastDiscoveryGeneration: 1,
    condition: "available",
    detail: null,
    ...overrides,
  });
}

const wslState: DesktopWslState = {
  available: true,
  distro: null,
  legacyAcceptedDistro: null,
  distros: [
    {
      isDefault: true,
      name: "Ubuntu",
      state: "running",
      version: 2,
    },
  ],
  discovery: discovery(1, [distro("Ubuntu")]),
  enabled: true,
  preflightError: null,
  wslOnly: false,
};

describe("desktopWslState", () => {
  it.each([
    {
      name: "shows a new running distro as setup required",
      input: {
        discovery: discovery(1, [distro("Ubuntu")]),
        observations: [],
        bindings: [],
        environments: [],
      },
      assert: (result: ReturnType<typeof reconcileDesktopWslBindings>) => {
        expect(result.bindings).toEqual([
          expect.objectContaining({
            bindingId: "new:Ubuntu",
            distroName: "Ubuntu",
            acceptedEnvironmentId: null,
            condition: "setup-required",
            lastDiscoveryGeneration: 1,
          }),
        ]);
        expect(result.presentations).toEqual([
          expect.objectContaining({ bindingId: "new:Ubuntu", visibility: "visible" }),
        ]);
      },
    },
    {
      name: "keeps a new stopped distro in discovery only",
      input: {
        discovery: discovery(1, [distro("Debian", "stopped")]),
        observations: [],
        bindings: [],
        environments: [],
      },
      assert: (result: ReturnType<typeof reconcileDesktopWslBindings>) => {
        expect(result.bindings).toEqual([]);
        expect(result.discoveryOnlyDistros.map((entry) => entry.name)).toEqual(["Debian"]);
      },
    },
    {
      name: "retains an accepted stopped distro as visible",
      input: {
        discovery: discovery(2, [distro("Ubuntu", "stopped")]),
        observations: [],
        bindings: [binding()],
        environments: [{ environmentId, hidden: false }],
      },
      assert: (result: ReturnType<typeof reconcileDesktopWslBindings>) => {
        expect(result.bindings[0]).toEqual(expect.objectContaining({ condition: "stopped" }));
        expect(result.presentations[0]).toEqual(expect.objectContaining({ visibility: "visible" }));
      },
    },
    {
      name: "keeps the binding when a proved server is observed after a distro rename",
      input: {
        discovery: discovery(2, [distro("Ubuntu-Renamed")]),
        observations: [{ distroName: "Ubuntu-Renamed", descriptor: descriptor() }],
        bindings: [binding()],
        environments: [{ environmentId, hidden: false }],
      },
      assert: (result: ReturnType<typeof reconcileDesktopWslBindings>) => {
        expect(result.bindings).toEqual([
          expect.objectContaining({
            bindingId: "binding-ubuntu",
            distroName: "Ubuntu-Renamed",
            acceptedEnvironmentId: environmentId,
            condition: "available",
          }),
        ]);
      },
    },
    {
      name: "blocks a reused distro name that reports another server identity",
      input: {
        discovery: discovery(2, [distro("Ubuntu")]),
        observations: [
          {
            distroName: "Ubuntu",
            descriptor: descriptor(otherEnvironmentId, otherStorageInstanceId),
          },
        ],
        bindings: [binding()],
        environments: [{ environmentId, hidden: false }],
      },
      assert: (result: ReturnType<typeof reconcileDesktopWslBindings>) => {
        expect(result.bindings[0]).toEqual(
          expect.objectContaining({
            acceptedEnvironmentId: environmentId,
            acceptedStorageInstanceIds: [storageInstanceId],
            condition: "identity-conflict",
          }),
        );
      },
    },
    {
      name: "retains a binding as unavailable when a newer snapshot omits it",
      input: {
        discovery: discovery(2, []),
        observations: [],
        bindings: [binding()],
        environments: [{ environmentId, hidden: false }],
      },
      assert: (result: ReturnType<typeof reconcileDesktopWslBindings>) => {
        expect(result.bindings[0]).toEqual(
          expect.objectContaining({ condition: "unavailable", lastDiscoveryGeneration: 2 }),
        );
      },
    },
    {
      name: "ignores a stale discovery generation",
      input: {
        discovery: discovery(1, []),
        observations: [],
        bindings: [binding({ lastDiscoveryGeneration: 2 })],
        environments: [{ environmentId, hidden: false }],
      },
      assert: (result: ReturnType<typeof reconcileDesktopWslBindings>) => {
        expect(result.ignoredStaleGeneration).toBe(true);
        expect(result.bindings).toEqual([binding({ lastDiscoveryGeneration: 2 })]);
      },
    },
    {
      name: "keeps a hidden environment binding without presenting its row",
      input: {
        discovery: discovery(2, [distro("Ubuntu")]),
        observations: [{ distroName: "Ubuntu", descriptor: descriptor() }],
        bindings: [binding()],
        environments: [{ environmentId, hidden: true }],
      },
      assert: (result: ReturnType<typeof reconcileDesktopWslBindings>) => {
        expect(result.bindings).toHaveLength(1);
        expect(result.presentations[0]).toEqual(
          expect.objectContaining({ bindingId: "binding-ubuntu", visibility: "hidden" }),
        );
      },
    },
    {
      name: "does not downgrade a verified binding after discovery failure",
      input: {
        discovery: discovery(2, [distro("Ubuntu")], "failed"),
        observations: [],
        bindings: [binding()],
        environments: [{ environmentId, hidden: false }],
      },
      assert: (result: ReturnType<typeof reconcileDesktopWslBindings>) => {
        expect(result.bindings).toEqual([binding()]);
        expect(result.presentations[0]).toEqual(
          expect.objectContaining({ bindingId: "binding-ubuntu", visibility: "visible" }),
        );
      },
    },
  ])("$name", ({ input, assert }) => {
    const result = reconcileDesktopWslBindings({
      ...input,
      observedAt,
      createBindingId: (name) => `new:${name}`,
      legacyAcceptedDistro: null,
    });
    assert(result);
  });

  it("imports the retired selected distro once as an accepted locator", () => {
    const result = reconcileDesktopWslBindings({
      discovery: discovery(3, [distro("Debian", "stopped")]),
      observations: [],
      bindings: [],
      environments: [],
      observedAt,
      createBindingId: (name) => `new:${name}`,
      legacyAcceptedDistro: "Debian",
    });

    expect(result.bindings).toEqual([
      expect.objectContaining({
        bindingId: "new:Debian",
        acceptedEnvironmentId: null,
        acceptedAt: observedAt,
        condition: "stopped",
      }),
    ]);
    expect(result.presentations[0]?.visibility).toBe("visible");
    expect(result.discoveryOnlyDistros).toEqual([]);
  });

  it("merges a transient rename candidate after the original descriptor returns", () => {
    const first = reconcileDesktopWslBindings({
      discovery: discovery(2, [distro("Ubuntu-Renamed")]),
      observations: [],
      bindings: [binding()],
      environments: [{ environmentId, hidden: false }],
      observedAt,
      createBindingId: (name) => `new:${name}`,
      legacyAcceptedDistro: null,
    });
    const transient = first.bindings.find((candidate) => candidate.bindingId.startsWith("new:"));
    expect(transient).toEqual(
      expect.objectContaining({
        distroName: "Ubuntu-Renamed",
        acceptedEnvironmentId: null,
        condition: "setup-required",
      }),
    );

    const proved = reconcileDesktopWslBindings({
      discovery: discovery(3, [distro("Ubuntu-Renamed")]),
      observations: [{ distroName: "Ubuntu-Renamed", descriptor: descriptor() }],
      bindings: first.bindings,
      environments: [{ environmentId, hidden: false }],
      observedAt,
      createBindingId: (name) => `new:${name}`,
      legacyAcceptedDistro: null,
    });

    expect(proved.bindings).toEqual([
      expect.objectContaining({
        bindingId: "binding-ubuntu",
        distroName: "Ubuntu-Renamed",
        acceptedEnvironmentId: environmentId,
        condition: "available",
      }),
    ]);
    expect(proved.supersededBindings).toEqual([transient]);
  });

  it("retains the loaded snapshot when the settings screen remounts", async () => {
    const getWslState = vi.fn(async () => wslState);
    const atom = createDesktopWslStateAtom(() => ({ getWslState }));
    const registry = AtomRegistry.make();

    const unmount = registry.mount(atom);
    await vi.waitFor(() => {
      expect(AsyncResult.value(registry.get(atom))).toEqual(
        expect.objectContaining({ _tag: "Some", value: wslState }),
      );
    });
    unmount();

    const remount = registry.mount(atom);
    expect(AsyncResult.value(registry.get(atom))).toEqual(
      expect.objectContaining({ _tag: "Some", value: wslState }),
    );
    expect(getWslState).toHaveBeenCalledTimes(1);

    remount();
    registry.dispose();
  });

  it("retains the desktop bridge failure as the load error cause", async () => {
    const cause = new Error("wsl unavailable");
    const atom = createDesktopWslStateAtom(() => ({
      getWslState: async () => Promise.reject(cause),
    }));
    const registry = AtomRegistry.make();
    registry.mount(atom);

    await vi.waitFor(() => expect(AsyncResult.isFailure(registry.get(atom))).toBe(true));
    const result = registry.get(atom);
    if (!AsyncResult.isFailure(result)) throw new Error("Expected WSL state load to fail.");

    expect(Cause.squash(result.cause)).toEqual(
      expect.objectContaining({
        _tag: "DesktopWslStateLoadError",
        cause,
      }),
    );
    registry.dispose();
  });

  it("replaces cached state with refreshed live desktop state", async () => {
    const refreshedState: DesktopWslState = {
      ...wslState,
      preflightError: {
        kind: "wsl-primary-unavailable",
        detail: "WSL backend stopped unexpectedly.",
      },
    };
    let currentState = wslState;
    const getWslState = vi.fn(async () => currentState);
    const atom = createDesktopWslStateAtom(() => ({ getWslState }));
    const registry = AtomRegistry.make();
    registry.mount(atom);

    await vi.waitFor(() => {
      expect(AsyncResult.value(registry.get(atom))).toEqual(
        expect.objectContaining({ _tag: "Some", value: wslState }),
      );
    });

    currentState = refreshedState;
    registry.refresh(atom);

    await vi.waitFor(() => {
      expect(AsyncResult.value(registry.get(atom))).toEqual(
        expect.objectContaining({ _tag: "Some", value: refreshedState }),
      );
    });
    expect(getWslState).toHaveBeenCalledTimes(2);
    registry.dispose();
  });

  it("applies decoded discovery events and ignores stale generations", async () => {
    let listener: ((discovery: DesktopWslState["discovery"]) => void) | undefined;
    const unsubscribe = vi.fn();
    const getWslState = vi.fn(async () => wslState);
    const atom = createDesktopWslStateAtom(() => ({
      getWslState,
      onWslDiscoveryChanged: (next) => {
        listener = next;
        return unsubscribe;
      },
    }));
    const registry = AtomRegistry.make();
    registry.mount(atom);
    await vi.waitFor(() => {
      expect(AsyncResult.value(registry.get(atom))).toEqual(
        expect.objectContaining({ _tag: "Some", value: wslState }),
      );
    });

    const newer = {
      ...wslState.discovery,
      generation: wslState.discovery.generation + 1,
      observedAt: "2026-08-25T00:00:02Z",
      distros: [
        { name: "Ubuntu", isDefault: true, state: "running" as const, version: 2 as const },
        { name: "Debian", isDefault: false, state: "stopped" as const, version: 2 as const },
      ],
    };
    listener?.(newer);
    await vi.waitFor(() => {
      expect(AsyncResult.value(registry.get(atom))).toEqual(
        expect.objectContaining({
          _tag: "Some",
          value: expect.objectContaining({ discovery: newer, distros: newer.distros }),
        }),
      );
    });

    listener?.({ ...wslState.discovery, generation: newer.generation - 1 });
    expect(AsyncResult.value(registry.get(atom))).toEqual(
      expect.objectContaining({
        _tag: "Some",
        value: expect.objectContaining({ discovery: newer }),
      }),
    );
    registry.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(getWslState).toHaveBeenCalledTimes(1);
  });
});
