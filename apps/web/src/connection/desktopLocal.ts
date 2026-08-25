import {
  DesktopWslBinding,
  type ConnectionTarget,
  type KnownEnvironment,
} from "@bibcode/client-runtime/connection";
import {
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type DesktopBridge,
  type DesktopEnvironmentBootstrap,
  type DesktopWslDiscovery,
  type DesktopWslDistro,
  type DesktopWslState,
  type ExecutionEnvironmentDescriptor,
} from "@bibcode/contracts";

export const DESKTOP_LOCAL_TOPOLOGY_SAFETY_MS = 5 * 60 * 1_000;

/**
 * Desktop-local secondary runtimes (for example, a parallel WSL server) are
 * registered by the connection platform source as bearer connections whose id
 * carries this prefix. The suffix is an opaque, process-lifetime runtime slot;
 * it is never a distro locator or durable environment identity.
 *
 * Keep this the one source of truth: the producer (`connection/platform.ts`)
 * mints ids via {@link desktopLocalConnectionId} and every consumer classifies
 * via {@link isDesktopLocalConnectionTarget}, so the convention can never drift
 * between the two.
 */
export const DESKTOP_LOCAL_CONNECTION_ID_PREFIX = "local:";

export function desktopLocalConnectionId(runtimeId: string): string {
  return `${DESKTOP_LOCAL_CONNECTION_ID_PREFIX}${runtimeId}`;
}

export function isDesktopLocalConnectionTarget(
  target: ConnectionTarget,
): target is Extract<
  ConnectionTarget,
  { readonly _tag: "BearerConnectionTarget" | "UnavailableConnectionTarget" }
> {
  return (
    (target._tag === "BearerConnectionTarget" || target._tag === "UnavailableConnectionTarget") &&
    target.connectionId.startsWith(DESKTOP_LOCAL_CONNECTION_ID_PREFIX)
  );
}

export function desktopLocalRuntimeId(target: ConnectionTarget): string | null {
  return isDesktopLocalConnectionTarget(target)
    ? target.connectionId.slice(DESKTOP_LOCAL_CONNECTION_ID_PREFIX.length)
    : null;
}

export type DesktopSecondaryBootstrapsRead =
  | {
      readonly _tag: "Success";
      readonly bootstraps: ReadonlyArray<DesktopEnvironmentBootstrap>;
    }
  | {
      readonly _tag: "Failure";
      readonly cause: unknown;
      readonly retainedBootstraps?: ReadonlyArray<DesktopEnvironmentBootstrap>;
    };

export interface DesktopSecondaryBootstrapsReader {
  readonly readResult: () => DesktopSecondaryBootstrapsRead;
  readonly readSnapshot: () => ReadonlyArray<DesktopEnvironmentBootstrap>;
}

/**
 * Build a topology reader whose snapshot advances only after successful bridge
 * reads. A successful empty read is authoritative; a thrown read preserves the
 * previous snapshot so UI consumers cannot temporarily disagree with the
 * platform's retained registrations.
 */
export function createDesktopSecondaryBootstrapsReader(
  resolveBridge: () => Pick<DesktopBridge, "getLocalEnvironmentBootstraps"> | undefined,
): DesktopSecondaryBootstrapsReader {
  let snapshot: ReadonlyArray<DesktopEnvironmentBootstrap> = [];

  const readResult = (): DesktopSecondaryBootstrapsRead => {
    const bridge = resolveBridge();
    if (bridge === undefined) {
      snapshot = [];
      return { _tag: "Success", bootstraps: snapshot };
    }
    try {
      snapshot = bridge
        .getLocalEnvironmentBootstraps()
        .filter((entry) => entry.id !== PRIMARY_LOCAL_ENVIRONMENT_ID);
      return { _tag: "Success", bootstraps: snapshot };
    } catch (cause) {
      return { _tag: "Failure", cause };
    }
  };

  return {
    readResult,
    readSnapshot: () => {
      const result = readResult();
      return result._tag === "Success" ? result.bootstraps : snapshot;
    },
  };
}

const desktopSecondaryBootstrapsReader = createDesktopSecondaryBootstrapsReader(
  () => window.desktopBridge,
);

/** Read the topology while preserving failures for platform cache policy. */
export function readDesktopSecondaryBootstrapsResult(): DesktopSecondaryBootstrapsRead {
  return desktopSecondaryBootstrapsReader.readResult();
}

/** Read the latest successful topology snapshot for renderer consumers. */
export function readDesktopSecondaryBootstraps(): ReadonlyArray<DesktopEnvironmentBootstrap> {
  return desktopSecondaryBootstrapsReader.readSnapshot();
}

type DesktopLocalTopologyBridge = Pick<
  DesktopBridge,
  "getLocalEnvironmentBootstraps" | "getWslState"
> &
  Partial<
    Pick<
      DesktopBridge,
      "onLocalEnvironmentBootstrapsChanged" | "onWslDiscoveryChanged" | "refreshWslDiscovery"
    >
  >;

export interface DesktopLocalTopologySnapshot {
  readonly secondaryBootstraps: DesktopSecondaryBootstrapsRead;
  readonly wslState: DesktopWslState | null;
  readonly wslStateError: unknown | null;
}

export interface DesktopLocalTopologyHost {
  readonly addEventListener: (type: "focus", listener: () => void) => void;
  readonly removeEventListener: (type: "focus", listener: () => void) => void;
  readonly setInterval: (listener: () => void, delay: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
}

export interface DesktopLocalTopologyController {
  readonly getSnapshot: () => DesktopLocalTopologySnapshot;
  readonly subscribe: (listener: (snapshot: DesktopLocalTopologySnapshot) => void) => () => void;
  readonly refresh: () => Promise<void>;
}

export function desktopWslStateWithDiscovery(
  current: DesktopWslState,
  discovery: DesktopWslDiscovery,
): DesktopWslState {
  if (discovery.generation <= current.discovery.generation) return current;
  const runningAvailable = discovery.distros.some((distro) => distro.state === "running");
  return {
    ...current,
    enabled: runningAvailable,
    available: discovery.health === "available",
    distros: discovery.distros,
    discovery,
  };
}

export interface DesktopWslServerObservation {
  readonly distroName: string;
  readonly descriptor: ExecutionEnvironmentDescriptor | null;
  readonly detail?: string | null;
}

export interface DesktopWslBindingPresentation {
  readonly bindingId: string;
  readonly environmentId: string | null;
  readonly visibility: "visible" | "hidden" | "discovery-only";
}

export interface DesktopWslBindingReconciliation {
  readonly bindings: ReadonlyArray<DesktopWslBinding>;
  /** Unproved locator rows superseded by a descriptor-proved binding. */
  readonly supersededBindings: ReadonlyArray<DesktopWslBinding>;
  readonly presentations: ReadonlyArray<DesktopWslBindingPresentation>;
  readonly discoveryOnlyDistros: ReadonlyArray<DesktopWslDistro>;
  readonly ignoredStaleGeneration: boolean;
}

export interface ReconcileDesktopWslBindingsInput {
  readonly discovery: DesktopWslDiscovery;
  readonly observations: ReadonlyArray<DesktopWslServerObservation>;
  readonly bindings: ReadonlyArray<DesktopWslBinding>;
  readonly environments: ReadonlyArray<Pick<KnownEnvironment, "environmentId" | "hidden">>;
  readonly observedAt: string;
  readonly createBindingId: (distroName: string) => string;
  /** One-shot input from the retired selected-distro desktop setting. */
  readonly legacyAcceptedDistro: string | null;
}

function distroKey(name: string): string {
  return name.trim().toLocaleLowerCase("en-US");
}

function bindingWith(
  binding: DesktopWslBinding,
  fields: Partial<DesktopWslBinding>,
): DesktopWslBinding {
  return new DesktopWslBinding({ ...binding, ...fields });
}

function bindingPresentation(
  binding: DesktopWslBinding,
  hiddenEnvironmentIds: ReadonlySet<string>,
  visibleUnprovedBindingIds: ReadonlySet<string>,
): DesktopWslBindingPresentation {
  const hidden =
    binding.acceptedEnvironmentId !== null &&
    hiddenEnvironmentIds.has(binding.acceptedEnvironmentId);
  const accepted = binding.acceptedEnvironmentId !== null || binding.acceptedAt !== null;
  return {
    bindingId: binding.bindingId,
    environmentId: binding.acceptedEnvironmentId,
    visibility: hidden
      ? "hidden"
      : accepted || visibleUnprovedBindingIds.has(binding.bindingId)
        ? "visible"
        : "discovery-only",
  };
}

/**
 * Reconcile mutable WSL distro locators without ever using them as server
 * identity. Descriptor UUIDs may move an existing binding to a renamed locator;
 * a locator that reports another UUID is blocked instead of reassigned.
 */
export function reconcileDesktopWslBindings(
  input: ReconcileDesktopWslBindingsInput,
): DesktopWslBindingReconciliation {
  const hiddenEnvironmentIds = new Set(
    input.environments
      .filter((environment) => environment.hidden)
      .map((environment) => environment.environmentId),
  );
  const newestPersistedGeneration = input.bindings.reduce(
    (newest, binding) => Math.max(newest, binding.lastDiscoveryGeneration),
    0,
  );
  if (input.discovery.generation < newestPersistedGeneration) {
    return {
      bindings: input.bindings,
      supersededBindings: [],
      presentations: input.bindings.map((binding) =>
        bindingPresentation(binding, hiddenEnvironmentIds, new Set()),
      ),
      discoveryOnlyDistros: [],
      ignoredStaleGeneration: true,
    };
  }
  if (input.discovery.health !== "available") {
    return {
      bindings: input.bindings,
      supersededBindings: [],
      presentations: input.bindings.map((binding) =>
        bindingPresentation(binding, hiddenEnvironmentIds, new Set()),
      ),
      discoveryOnlyDistros: [],
      ignoredStaleGeneration: false,
    };
  }

  const orderedBindingIds = input.bindings.map((binding) => binding.bindingId);
  const bindingsById = new Map(input.bindings.map((binding) => [binding.bindingId, binding]));
  const observationByDistro = new Map(
    input.observations.map((observation) => [distroKey(observation.distroName), observation]),
  );
  const processedBindingIds = new Set<string>();
  const supersededBindings: DesktopWslBinding[] = [];
  const visibleUnprovedBindingIds = new Set<string>();
  const discoveryOnlyDistros: DesktopWslDistro[] = [];

  const findLocatorBinding = (name: string) =>
    [...bindingsById.values()].find(
      (binding) =>
        !processedBindingIds.has(binding.bindingId) &&
        distroKey(binding.distroName) === distroKey(name),
    );
  const findIdentityBinding = (environmentId: string) =>
    [...bindingsById.values()].find(
      (binding) =>
        !processedBindingIds.has(binding.bindingId) &&
        binding.acceptedEnvironmentId === environmentId,
    );

  for (const distro of input.discovery.distros) {
    const observation = observationByDistro.get(distroKey(distro.name));
    const locatorBinding = findLocatorBinding(distro.name);
    const descriptorBinding =
      observation?.descriptor === null || observation?.descriptor === undefined
        ? undefined
        : findIdentityBinding(observation.descriptor.environmentId);
    if (
      descriptorBinding !== undefined &&
      locatorBinding !== undefined &&
      descriptorBinding.bindingId !== locatorBinding.bindingId &&
      locatorBinding.acceptedEnvironmentId === null &&
      locatorBinding.acceptedAt === null
    ) {
      supersededBindings.push(locatorBinding);
      processedBindingIds.add(locatorBinding.bindingId);
      bindingsById.delete(locatorBinding.bindingId);
    }
    const existing = descriptorBinding ?? locatorBinding;
    const legacyAccepted =
      input.legacyAcceptedDistro !== null &&
      distroKey(input.legacyAcceptedDistro) === distroKey(distro.name);

    if (distro.state === "stopped" && existing === undefined && !legacyAccepted) {
      discoveryOnlyDistros.push(distro);
      continue;
    }

    const current =
      existing ??
      new DesktopWslBinding({
        bindingId: input.createBindingId(distro.name),
        distroName: distro.name,
        acceptedEnvironmentId: null,
        acceptedStorageInstanceIds: [],
        acceptedAt: legacyAccepted ? input.observedAt : null,
        lastDiscoveryGeneration: input.discovery.generation,
        condition: distro.state === "stopped" ? "stopped" : "setup-required",
        detail: null,
      });
    if (!bindingsById.has(current.bindingId)) orderedBindingIds.push(current.bindingId);
    processedBindingIds.add(current.bindingId);

    let next: DesktopWslBinding;
    if (distro.state === "stopped") {
      next = bindingWith(current, {
        distroName: distro.name,
        acceptedAt: current.acceptedAt ?? (legacyAccepted ? input.observedAt : null),
        lastDiscoveryGeneration: input.discovery.generation,
        condition: "stopped",
        detail: null,
      });
    } else if (observation?.descriptor !== null && observation?.descriptor !== undefined) {
      const descriptor = observation.descriptor;
      const locatorIdentityConflict =
        locatorBinding?.acceptedEnvironmentId !== null &&
        locatorBinding?.acceptedEnvironmentId !== undefined &&
        locatorBinding.acceptedEnvironmentId !== descriptor.environmentId;
      const acceptedStorageConflict =
        current.acceptedEnvironmentId === descriptor.environmentId &&
        current.acceptedStorageInstanceIds.length > 0 &&
        !current.acceptedStorageInstanceIds.includes(descriptor.storageInstanceId);
      if (
        locatorIdentityConflict ||
        (current.acceptedEnvironmentId !== null &&
          current.acceptedEnvironmentId !== descriptor.environmentId) ||
        acceptedStorageConflict
      ) {
        const conflicted = locatorIdentityConflict ? locatorBinding : current;
        if (conflicted === undefined) throw new Error("Expected a conflicting WSL binding.");
        next = bindingWith(conflicted, {
          lastDiscoveryGeneration: input.discovery.generation,
          condition: "identity-conflict",
          detail:
            "This WSL locator reports a different environment or storage identity than the accepted binding.",
        });
        processedBindingIds.add(conflicted.bindingId);
      } else {
        next = bindingWith(current, {
          distroName: distro.name,
          acceptedEnvironmentId: descriptor.environmentId,
          acceptedStorageInstanceIds:
            current.acceptedStorageInstanceIds.length === 0
              ? [descriptor.storageInstanceId]
              : current.acceptedStorageInstanceIds,
          acceptedAt: current.acceptedAt ?? input.observedAt,
          lastDiscoveryGeneration: input.discovery.generation,
          condition: "available",
          detail: null,
        });
      }
    } else {
      next = bindingWith(current, {
        distroName: distro.name,
        acceptedAt: current.acceptedAt ?? (legacyAccepted ? input.observedAt : null),
        lastDiscoveryGeneration: input.discovery.generation,
        condition: "setup-required",
        detail:
          observation?.detail ??
          "BiBCode Server is not available in this running WSL distribution.",
      });
      if (next.acceptedEnvironmentId === null && next.acceptedAt === null) {
        visibleUnprovedBindingIds.add(next.bindingId);
      }
    }
    bindingsById.set(next.bindingId, next);
  }

  for (const bindingId of orderedBindingIds) {
    if (processedBindingIds.has(bindingId)) continue;
    const binding = bindingsById.get(bindingId);
    if (binding === undefined) continue;
    bindingsById.set(
      bindingId,
      bindingWith(binding, {
        lastDiscoveryGeneration: input.discovery.generation,
        condition: "unavailable",
        detail:
          input.discovery.detail ??
          "This WSL distribution was not present in the latest authoritative discovery snapshot.",
      }),
    );
  }

  const bindings = orderedBindingIds.flatMap((bindingId) => {
    const binding = bindingsById.get(bindingId);
    return binding === undefined ? [] : [binding];
  });
  return {
    bindings,
    supersededBindings,
    presentations: bindings.map((binding) =>
      bindingPresentation(binding, hiddenEnvironmentIds, visibleUnprovedBindingIds),
    ),
    discoveryOnlyDistros,
    ignoredStaleGeneration: false,
  };
}

function filterSecondaryBootstraps(
  bootstraps: readonly DesktopEnvironmentBootstrap[],
): ReadonlyArray<DesktopEnvironmentBootstrap> {
  return bootstraps.filter((entry) => entry.id !== PRIMARY_LOCAL_ENVIRONMENT_ID);
}

/**
 * Own the renderer side of desktop topology observation. Native discovery
 * events are authoritative; focus/manual requests are single-flighted and the
 * five-minute timer is only a missed-event safety net.
 */
export function createDesktopLocalTopologyController(input: {
  readonly resolveBridge: () => DesktopLocalTopologyBridge | undefined;
  readonly host: DesktopLocalTopologyHost;
}): DesktopLocalTopologyController {
  const listeners = new Set<(snapshot: DesktopLocalTopologySnapshot) => void>();
  const reader = createDesktopSecondaryBootstrapsReader(input.resolveBridge);
  let snapshot: DesktopLocalTopologySnapshot = {
    secondaryBootstraps: { _tag: "Success", bootstraps: [] },
    wslState: null,
    wslStateError: null,
  };
  let pendingDiscovery: DesktopWslDiscovery | null = null;
  let running = false;
  let lifecycleGeneration = 0;
  let bridge: DesktopLocalTopologyBridge | undefined;
  let refreshPromise: Promise<void> | null = null;
  let intervalHandle: unknown;
  let disposeWslDiscovery: (() => void) | undefined;
  let disposeBootstraps: (() => void) | undefined;
  let readScheduled = false;

  const publish = (next: DesktopLocalTopologySnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener(snapshot);
  };

  const readBootstraps = () => {
    const result = reader.readResult();
    publish({
      ...snapshot,
      secondaryBootstraps:
        result._tag === "Success"
          ? result
          : {
              ...result,
              retainedBootstraps:
                snapshot.secondaryBootstraps._tag === "Success"
                  ? snapshot.secondaryBootstraps.bootstraps
                  : (snapshot.secondaryBootstraps.retainedBootstraps ?? []),
            },
    });
  };

  const applyState = (state: DesktopWslState) => {
    const withPending =
      pendingDiscovery === null ? state : desktopWslStateWithDiscovery(state, pendingDiscovery);
    pendingDiscovery = null;
    const currentGeneration = snapshot.wslState?.discovery.generation ?? -1;
    if (withPending.discovery.generation < currentGeneration) return;
    publish({ ...snapshot, wslState: withPending, wslStateError: null });
  };

  const applyDiscovery = (discovery: DesktopWslDiscovery) => {
    const currentGeneration =
      snapshot.wslState?.discovery.generation ?? pendingDiscovery?.generation ?? -1;
    if (discovery.generation <= currentGeneration) return;
    if (snapshot.wslState === null) {
      pendingDiscovery = discovery;
    } else {
      publish({
        ...snapshot,
        wslState: desktopWslStateWithDiscovery(snapshot.wslState, discovery),
      });
    }
    readBootstraps();
  };

  const refresh = (): Promise<void> => {
    if (!running || bridge === undefined) return Promise.resolve();
    if (refreshPromise !== null) return refreshPromise;
    const generation = lifecycleGeneration;
    const refreshState = bridge.refreshWslDiscovery ?? bridge.getWslState;
    refreshPromise = refreshState()
      .then((state) => {
        if (running && generation === lifecycleGeneration) {
          applyState(state);
          readBootstraps();
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (generation === lifecycleGeneration) refreshPromise = null;
      });
    return refreshPromise;
  };

  const scheduleRead = () => {
    if (readScheduled || !running) return;
    readScheduled = true;
    const generation = lifecycleGeneration;
    queueMicrotask(() => {
      readScheduled = false;
      if (running && generation === lifecycleGeneration) readBootstraps();
    });
  };

  const onFocus = () => {
    // The native host owns focus-triggered WSL enumeration and emits the typed
    // discovery event. The renderer only coalesces a cached topology read here.
    scheduleRead();
  };

  const onSafetyWakeup = () => {
    void refresh();
  };

  const start = () => {
    running = true;
    lifecycleGeneration += 1;
    const generation = lifecycleGeneration;
    bridge = input.resolveBridge();
    if (bridge === undefined) {
      readBootstraps();
      return;
    }
    disposeWslDiscovery = bridge.onWslDiscoveryChanged?.(applyDiscovery);
    disposeBootstraps = bridge.onLocalEnvironmentBootstrapsChanged?.((bootstraps) => {
      publish({
        ...snapshot,
        secondaryBootstraps: {
          _tag: "Success",
          bootstraps: filterSecondaryBootstraps(bootstraps),
        },
      });
    });
    input.host.addEventListener("focus", onFocus);
    intervalHandle = input.host.setInterval(onSafetyWakeup, DESKTOP_LOCAL_TOPOLOGY_SAFETY_MS);
    readBootstraps();
    void bridge
      .getWslState()
      .then((state) => {
        if (running && generation === lifecycleGeneration) applyState(state);
      })
      .catch((cause) => {
        if (running && generation === lifecycleGeneration) {
          publish({ ...snapshot, wslStateError: cause });
        }
      });
  };

  const stop = () => {
    if (!running) return;
    running = false;
    lifecycleGeneration += 1;
    refreshPromise = null;
    readScheduled = false;
    disposeWslDiscovery?.();
    disposeBootstraps?.();
    disposeWslDiscovery = undefined;
    disposeBootstraps = undefined;
    input.host.removeEventListener("focus", onFocus);
    if (intervalHandle !== undefined) input.host.clearInterval(intervalHandle);
    intervalHandle = undefined;
    bridge = undefined;
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      if (!running) start();
      else listener(snapshot);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stop();
      };
    },
    refresh,
  };
}

const desktopLocalTopologyController = createDesktopLocalTopologyController({
  resolveBridge: () => (typeof window === "undefined" ? undefined : window.desktopBridge),
  host: {
    addEventListener: (type, listener) => window.addEventListener(type, listener),
    removeEventListener: (type, listener) => window.removeEventListener(type, listener),
    setInterval: (listener, delay) => globalThis.setInterval(listener, delay),
    clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
  },
});

export function readDesktopLocalTopologySnapshot(): DesktopLocalTopologySnapshot {
  return desktopLocalTopologyController.getSnapshot();
}

export function observeDesktopLocalTopology(
  listener: (snapshot: DesktopLocalTopologySnapshot) => void,
): () => void {
  return desktopLocalTopologyController.subscribe(listener);
}

export function refreshDesktopLocalTopology(): Promise<void> {
  return desktopLocalTopologyController.refresh();
}
