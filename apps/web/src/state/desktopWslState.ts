import { DesktopWslBinding, type KnownEnvironment } from "@bibcode/client-runtime/connection";
import type {
  DesktopBridge,
  DesktopWslDiscovery,
  DesktopWslDistro,
  DesktopWslState,
  ExecutionEnvironmentDescriptor,
} from "@bibcode/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

const DESKTOP_WSL_STATE_STALE_TIME_MS = 30_000;

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
      presentations: input.bindings.map((binding) =>
        bindingPresentation(binding, hiddenEnvironmentIds, new Set()),
      ),
      discoveryOnlyDistros: [],
      ignoredStaleGeneration: true,
    };
  }

  const orderedBindingIds = input.bindings.map((binding) => binding.bindingId);
  const bindingsById = new Map(input.bindings.map((binding) => [binding.bindingId, binding]));
  const observationByDistro = new Map(
    input.observations.map((observation) => [distroKey(observation.distroName), observation]),
  );
  const processedBindingIds = new Set<string>();
  const visibleUnprovedBindingIds = new Set<string>();
  const discoveryOnlyDistros: DesktopWslDistro[] = [];
  const authoritativeDistros =
    input.discovery.health === "available" ? input.discovery.distros : [];

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

  for (const distro of authoritativeDistros) {
    const observation = observationByDistro.get(distroKey(distro.name));
    const locatorBinding = findLocatorBinding(distro.name);
    const descriptorBinding =
      observation?.descriptor === null || observation?.descriptor === undefined
        ? undefined
        : findIdentityBinding(observation.descriptor.environmentId);
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
    if (!bindingsById.has(current.bindingId)) {
      orderedBindingIds.push(current.bindingId);
    }
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
    presentations: bindings.map((binding) =>
      bindingPresentation(binding, hiddenEnvironmentIds, visibleUnprovedBindingIds),
    ),
    discoveryOnlyDistros,
    ignoredStaleGeneration: false,
  };
}

type DesktopWslStateBridge = Pick<DesktopBridge, "getWslState">;

class DesktopWslStateUnavailableError extends Schema.TaggedErrorClass<DesktopWslStateUnavailableError>()(
  "DesktopWslStateUnavailableError",
  {},
) {
  override get message(): string {
    return "Desktop WSL state is unavailable.";
  }
}

class DesktopWslStateLoadError extends Schema.TaggedErrorClass<DesktopWslStateLoadError>()(
  "DesktopWslStateLoadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to load WSL state.";
  }
}

function getDesktopWslStateBridge(): DesktopWslStateBridge | undefined {
  return typeof window === "undefined" ? undefined : window.desktopBridge;
}

export function createDesktopWslStateAtom(getBridge: () => DesktopWslStateBridge | undefined) {
  const loadDesktopWslState = Effect.fn("loadDesktopWslState")(function* () {
    const bridge = getBridge();
    if (!bridge) {
      return yield* new DesktopWslStateUnavailableError();
    }
    return yield* Effect.tryPromise({
      try: (): Promise<DesktopWslState> => bridge.getWslState(),
      catch: (cause) => new DesktopWslStateLoadError({ cause }),
    });
  });

  return Atom.make(loadDesktopWslState()).pipe(
    Atom.swr({
      staleTime: DESKTOP_WSL_STATE_STALE_TIME_MS,
      revalidateOnMount: true,
    }),
    Atom.keepAlive,
    Atom.withLabel("desktop:wsl-state:load"),
  );
}

export const desktopWslStateAtom = createDesktopWslStateAtom(getDesktopWslStateBridge);

export function refreshDesktopWslState(): void {
  appAtomRegistry.refresh(desktopWslStateAtom);
}
