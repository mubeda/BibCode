import type { EnvironmentClientCleanupRepairReceipt } from "@bibcode/client-runtime/platform";
import type { AtomCommand } from "@bibcode/client-runtime/state/runtime";
import { EnvironmentId } from "@bibcode/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  reconcileForgottenEnvironmentClientCleanup,
  withForgottenEnvironmentClientCleanup,
  type ForgottenEnvironmentClientCleanupRepairBoundary,
} from "./catalog";

const ENVIRONMENT_ID = EnvironmentId.make("environment-forget");
const OTHER_ENVIRONMENT_ID = EnvironmentId.make("environment-other");

describe("environment catalog client cleanup", () => {
  it("clears client-only stores only after successful authoritative Forget", async () => {
    const cleanup = vi.fn(() => true);
    const repairs = memoryRepairs();
    const registry = AtomRegistry.make();
    const success = successfulForget();

    const result = await withForgottenEnvironmentClientCleanup(success, {
      cleanup,
      repairs: repairs.boundary,
    }).run(registry, ENVIRONMENT_ID);

    expect(result._tag).toBe("Success");
    expect(cleanup).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledWith(ENVIRONMENT_ID);
    expect([...repairs.values.values()]).toEqual([]);
    registry.dispose();
  });

  it("retains client metadata and its prepared repair after failed authoritative Forget", async () => {
    const cleanup = vi.fn(() => true);
    const repairs = memoryRepairs();
    const registry = AtomRegistry.make();
    const failure = failedForget();

    const result = await withForgottenEnvironmentClientCleanup(failure, {
      cleanup,
      repairs: repairs.boundary,
    }).run(registry, ENVIRONMENT_ID);

    expect(result._tag).toBe("Failure");
    expect(cleanup).not.toHaveBeenCalled();
    expect(repairs.values.get(ENVIRONMENT_ID)?.phase).toBe("prepared");
    registry.dispose();
  });

  it("surfaces incomplete client cleanup and retains a confirmed repair", async () => {
    const repairs = memoryRepairs();
    const registry = AtomRegistry.make();

    const result = await withForgottenEnvironmentClientCleanup(successfulForget(), {
      cleanup: () => false,
      repairs: repairs.boundary,
    }).run(registry, ENVIRONMENT_ID);

    expect(result._tag).toBe("Failure");
    expect(repairs.values.get(ENVIRONMENT_ID)?.phase).toBe("confirmed");
    registry.dispose();
  });

  it("does not start authoritative Forget when the repair is not durable", async () => {
    const registry = AtomRegistry.make();
    const run = vi.fn(async () => AsyncResult.success(undefined));
    const success: AtomCommand<typeof ENVIRONMENT_ID, void, never> = {
      label: "test:forget",
      run,
    };
    const repairs = memoryRepairs({ failSave: true });

    const result = await withForgottenEnvironmentClientCleanup(success, {
      cleanup: () => true,
      repairs: repairs.boundary,
    }).run(registry, ENVIRONMENT_ID);

    expect(result._tag).toBe("Failure");
    expect(run).not.toHaveBeenCalled();
    registry.dispose();
  });

  it("repairs a prepared receipt after restart when the environment is absent", async () => {
    const repairs = memoryRepairs({
      initial: [{ schemaVersion: 1, environmentId: ENVIRONMENT_ID, phase: "prepared" }],
    });
    const cleanup = vi.fn(() => true);
    const registry = AtomRegistry.make();

    const result = await reconcileForgottenEnvironmentClientCleanup(registry, new Set(), {
      cleanup,
      repairs: repairs.boundary,
    });

    expect(result).toEqual({
      repairedEnvironmentIds: [ENVIRONMENT_ID],
      incompleteEnvironmentIds: [],
      storageError: false,
    });
    expect(cleanup).toHaveBeenCalledWith(ENVIRONMENT_ID);
    expect([...repairs.values.values()]).toEqual([]);
    registry.dispose();
  });

  it("retains an unconfirmed repair while the environment still exists", async () => {
    const repairs = memoryRepairs({
      initial: [{ schemaVersion: 1, environmentId: ENVIRONMENT_ID, phase: "prepared" }],
    });
    const cleanup = vi.fn(() => true);
    const registry = AtomRegistry.make();

    const result = await reconcileForgottenEnvironmentClientCleanup(
      registry,
      new Set([ENVIRONMENT_ID]),
      { cleanup, repairs: repairs.boundary },
    );

    expect(result).toEqual({
      repairedEnvironmentIds: [],
      incompleteEnvironmentIds: [],
      storageError: false,
    });
    expect(cleanup).not.toHaveBeenCalled();
    expect(repairs.values.get(ENVIRONMENT_ID)?.phase).toBe("prepared");
    registry.dispose();
  });

  it("keeps concurrent repairs for different environments independently keyed", async () => {
    const repairs = memoryRepairs();
    const registry = AtomRegistry.make();
    const wrapped = withForgottenEnvironmentClientCleanup(failedForget(), {
      cleanup: () => true,
      repairs: repairs.boundary,
    });

    await Promise.all([
      wrapped.run(registry, ENVIRONMENT_ID),
      wrapped.run(registry, OTHER_ENVIRONMENT_ID),
    ]);

    expect([...repairs.values.keys()].sort()).toEqual(
      [ENVIRONMENT_ID, OTHER_ENVIRONMENT_ID].sort(),
    );
    registry.dispose();
  });
});

function successfulForget(): AtomCommand<EnvironmentId, void, never> {
  return {
    label: "test:forget",
    run: vi.fn(async () => AsyncResult.success(undefined)),
  };
}

function failedForget(): AtomCommand<EnvironmentId, void, string> {
  return {
    label: "test:forget",
    run: vi.fn(async () => AsyncResult.failure<void, string>(Cause.fail("failed"))),
  };
}

function memoryRepairs(
  options: {
    readonly initial?: readonly EnvironmentClientCleanupRepairReceipt[];
    readonly failSave?: boolean;
  } = {},
) {
  const values = new Map(
    (options.initial ?? []).map((receipt) => [receipt.environmentId, receipt]),
  );
  const boundary: ForgottenEnvironmentClientCleanupRepairBoundary = {
    save: async (_registry, receipt) => {
      if (options.failSave === true) return false;
      values.set(receipt.environmentId, receipt);
      return true;
    },
    remove: async (_registry, environmentId) => values.delete(environmentId),
    list: async () => [...values.values()],
  };
  return {
    values,
    boundary,
  };
}
