import { parseScopedProjectKey, parseScopedThreadKey } from "@bibcode/client-runtime/environment";
import {
  EnvironmentCleanupStore,
  type EnvironmentClientCleanupRepairReceipt,
} from "@bibcode/client-runtime/platform";
import { createEnvironmentCatalogAtoms } from "@bibcode/client-runtime/state/connections";
import { createRuntimeCommand, type AtomCommand } from "@bibcode/client-runtime/state/runtime";
import type { EnvironmentId } from "@bibcode/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { AsyncResult, type AtomRegistry } from "effect/unstable/reactivity";

import {
  migratePersistedSidebarWorkspaceMetaState,
  SIDEBAR_WORKSPACE_META_STORAGE_KEY,
  useSidebarWorkspaceMetaStore,
} from "../sidebarWorkspaceMetaStore";
import {
  parsePersistedState,
  PERSISTED_STATE_KEY,
  useUiStateStore,
  type PersistedUiState,
  type UiState,
} from "../uiStateStore";
import { connectionAtomRuntime } from "./runtime";

interface SynchronousClientStorage {
  readonly getItem: (key: string) => string | null;
}

export class ForgottenEnvironmentClientCleanupError extends Error {
  readonly _tag = "ForgottenEnvironmentClientCleanupError";

  constructor(
    message: string,
    readonly authoritativeForgetSucceeded: boolean,
  ) {
    super(message);
    this.name = "ForgottenEnvironmentClientCleanupError";
  }
}

function browserLocalStorage(): SynchronousClientStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function hasEnvironmentUiMetadata(state: UiState, environmentId: EnvironmentId): boolean {
  const projectBelongsToEnvironment = (key: string): boolean =>
    parseScopedProjectKey(key)?.environmentId === environmentId;
  const threadBelongsToEnvironment = (key: string): boolean =>
    parseScopedThreadKey(key)?.environmentId === environmentId;
  return (
    Object.keys(state.projectExpandedById).some(projectBelongsToEnvironment) ||
    state.projectOrder.some(projectBelongsToEnvironment) ||
    Object.keys(state.threadLastVisitedAtById).some(threadBelongsToEnvironment) ||
    Object.keys(state.threadChangedFilesExpandedById).some(threadBelongsToEnvironment)
  );
}

function persistedClientMetadataIsClear(
  environmentId: EnvironmentId,
  storage: SynchronousClientStorage,
): boolean {
  try {
    const sidebarRaw = storage.getItem(SIDEBAR_WORKSPACE_META_STORAGE_KEY);
    if (sidebarRaw !== null) {
      const parsed = JSON.parse(sidebarRaw) as { readonly state?: unknown };
      const sidebar = migratePersistedSidebarWorkspaceMetaState(parsed.state ?? parsed);
      if (
        [...sidebar.pinnedThreadKeys, ...sidebar.unreadThreadKeys].some(
          (key) => parseScopedThreadKey(key)?.environmentId === environmentId,
        )
      ) {
        return false;
      }
    }

    const uiRaw = storage.getItem(PERSISTED_STATE_KEY);
    if (
      uiRaw !== null &&
      hasEnvironmentUiMetadata(
        parsePersistedState(JSON.parse(uiRaw) as PersistedUiState),
        environmentId,
      )
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function clearForgottenEnvironmentClientState(
  environmentId: EnvironmentId,
  storage: SynchronousClientStorage | null = browserLocalStorage(),
): boolean {
  if (typeof window !== "undefined" && storage === null) return false;
  try {
    useSidebarWorkspaceMetaStore.getState().clearEnvironment(environmentId);
    useUiStateStore.getState().clearEnvironment(environmentId);
  } catch {
    return false;
  }
  const sidebarState = useSidebarWorkspaceMetaStore.getState();
  const uiState = useUiStateStore.getState();
  const inMemoryClear =
    ![...sidebarState.pinnedThreadKeys, ...sidebarState.unreadThreadKeys].some(
      (key) => parseScopedThreadKey(key)?.environmentId === environmentId,
    ) && !hasEnvironmentUiMetadata(uiState, environmentId);
  return (
    inMemoryClear && (storage === null || persistedClientMetadataIsClear(environmentId, storage))
  );
}

const saveClientCleanupRepair = createRuntimeCommand(connectionAtomRuntime, {
  label: "environment-catalog:save-client-cleanup-repair",
  execute: (receipt: EnvironmentClientCleanupRepairReceipt) =>
    EnvironmentCleanupStore.pipe(Effect.flatMap((store) => store.saveClientRepair(receipt))),
});

const removeClientCleanupRepair = createRuntimeCommand(connectionAtomRuntime, {
  label: "environment-catalog:remove-client-cleanup-repair",
  execute: (environmentId: EnvironmentId) =>
    EnvironmentCleanupStore.pipe(
      Effect.flatMap((store) => store.removeClientRepair(environmentId)),
    ),
});

const listClientCleanupRepairs = createRuntimeCommand(connectionAtomRuntime, {
  label: "environment-catalog:list-client-cleanup-repairs",
  execute: (_input: void) =>
    EnvironmentCleanupStore.pipe(Effect.flatMap((store) => store.clientRepairs)),
});

export interface ForgottenEnvironmentClientCleanupRepairBoundary {
  readonly save: (
    registry: AtomRegistry.AtomRegistry,
    receipt: EnvironmentClientCleanupRepairReceipt,
  ) => Promise<boolean>;
  readonly remove: (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
  ) => Promise<boolean>;
  readonly list: (
    registry: AtomRegistry.AtomRegistry,
  ) => Promise<readonly EnvironmentClientCleanupRepairReceipt[] | null>;
}

const durableClientCleanupRepairs: ForgottenEnvironmentClientCleanupRepairBoundary = {
  save: async (registry, receipt) =>
    (await saveClientCleanupRepair.run(registry, receipt))._tag === "Success",
  remove: async (registry, environmentId) =>
    (await removeClientCleanupRepair.run(registry, environmentId))._tag === "Success",
  list: async (registry) => {
    const result = await listClientCleanupRepairs.run(registry, undefined);
    return result._tag === "Success" ? result.value : null;
  },
};

export interface ForgottenEnvironmentClientCleanupOptions {
  readonly cleanup?: (environmentId: EnvironmentId) => boolean;
  readonly repairs?: ForgottenEnvironmentClientCleanupRepairBoundary;
}

function repairReceipt(
  environmentId: EnvironmentId,
  phase: EnvironmentClientCleanupRepairReceipt["phase"],
): EnvironmentClientCleanupRepairReceipt {
  return { schemaVersion: 1, environmentId, phase };
}

export function withForgottenEnvironmentClientCleanup<A, E>(
  command: AtomCommand<EnvironmentId, A, E>,
  options: ForgottenEnvironmentClientCleanupOptions = {},
): AtomCommand<EnvironmentId, A, E | ForgottenEnvironmentClientCleanupError> {
  const repairs = options.repairs ?? durableClientCleanupRepairs;
  const cleanup = options.cleanup ?? clearForgottenEnvironmentClientState;
  return {
    ...command,
    run: async (registry, environmentId) => {
      if (!(await repairs.save(registry, repairReceipt(environmentId, "prepared")))) {
        return AsyncResult.failure<A, E | ForgottenEnvironmentClientCleanupError>(
          Cause.fail(
            new ForgottenEnvironmentClientCleanupError(
              "Forget was not started because its local privacy cleanup could not be made durable.",
              false,
            ),
          ),
        );
      }
      const result = await command.run(registry, environmentId);
      if (result._tag === "Failure") return result;

      const confirmed = await repairs.save(registry, repairReceipt(environmentId, "confirmed"));
      const cleaned = cleanup(environmentId);
      const receiptCleared =
        confirmed && cleaned && (await repairs.remove(registry, environmentId));
      if (!confirmed || !cleaned || !receiptCleared) {
        return AsyncResult.failure<A, E | ForgottenEnvironmentClientCleanupError>(
          Cause.fail(
            new ForgottenEnvironmentClientCleanupError(
              "The environment was forgotten, but private client metadata cleanup is incomplete and will be retried after restart.",
              true,
            ),
          ),
        );
      }
      return result;
    },
  };
}

export interface ReconcileForgottenEnvironmentClientCleanupResult {
  readonly repairedEnvironmentIds: readonly EnvironmentId[];
  readonly incompleteEnvironmentIds: readonly EnvironmentId[];
  readonly storageError: boolean;
}

export async function reconcileForgottenEnvironmentClientCleanup(
  registry: AtomRegistry.AtomRegistry,
  activeEnvironmentIds: ReadonlySet<EnvironmentId>,
  options: ForgottenEnvironmentClientCleanupOptions = {},
): Promise<ReconcileForgottenEnvironmentClientCleanupResult> {
  const repairs = options.repairs ?? durableClientCleanupRepairs;
  const cleanup = options.cleanup ?? clearForgottenEnvironmentClientState;
  const receipts = await repairs.list(registry);
  if (receipts === null) {
    return { repairedEnvironmentIds: [], incompleteEnvironmentIds: [], storageError: true };
  }

  const repairedEnvironmentIds: EnvironmentId[] = [];
  const incompleteEnvironmentIds: EnvironmentId[] = [];
  for (const receipt of receipts) {
    if (receipt.phase === "prepared" && activeEnvironmentIds.has(receipt.environmentId)) {
      continue;
    }
    if (cleanup(receipt.environmentId) && (await repairs.remove(registry, receipt.environmentId))) {
      repairedEnvironmentIds.push(receipt.environmentId);
    } else {
      incompleteEnvironmentIds.push(receipt.environmentId);
    }
  }
  return { repairedEnvironmentIds, incompleteEnvironmentIds, storageError: false };
}

const catalog = createEnvironmentCatalogAtoms(connectionAtomRuntime);

export const environmentCatalog = {
  ...catalog,
  remove: withForgottenEnvironmentClientCleanup(catalog.remove),
};
