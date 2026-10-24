import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@bibcode/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  DISCONNECTED_ENVIRONMENT_REASON,
  initialProviderUpdateAllRows,
  planProviderUpdates,
  providerUpdateAllOutcome,
  runProviderUpdatePlan,
  type ProviderUpdateAllStatus,
  type ProviderUpdateCommandResult,
} from "./ProviderUpdateAll.logic";
import type { ProviderUpdateCandidate } from "./ProviderUpdateLaunchNotification.logic";

const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");
const local = EnvironmentId.make("local");
const ssh = EnvironmentId.make("ssh-devbox");
const relay = EnvironmentId.make("relay-laptop");

function provider(input: {
  readonly driver: ReturnType<typeof ProviderDriverKind.make>;
  readonly instanceId?: string;
  readonly canUpdate?: boolean;
  readonly status?: NonNullable<ServerProvider["versionAdvisory"]>["status"];
  readonly updateState?: ServerProvider["updateState"];
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId ?? String(input.driver)),
    driver: input.driver,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-24T10:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    agents: [],
    versionAdvisory: {
      status: input.status ?? "behind_latest",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      updateCommand: "npm install -g provider",
      canUpdate: input.canUpdate ?? true,
      checkedAt: "2026-10-24T10:00:00.000Z",
      message: null,
    },
    ...(input.updateState === undefined ? {} : { updateState: input.updateState }),
  };
}

function updateState(
  status: NonNullable<ServerProvider["updateState"]>["status"],
  message: string | null = null,
): ServerProvider["updateState"] {
  return { status, startedAt: null, finishedAt: null, message, output: null };
}

function success(providers: ReadonlyArray<ServerProvider>): ProviderUpdateCommandResult {
  return AsyncResult.success({ providers }) as ProviderUpdateCommandResult;
}

function failure(message: string): ProviderUpdateCommandResult {
  return AsyncResult.failure(Cause.fail(new Error(message))) as ProviderUpdateCommandResult;
}

function interrupted(): ProviderUpdateCommandResult {
  return AsyncResult.failure(Cause.interrupt()) as ProviderUpdateCommandResult;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("planProviderUpdates", () => {
  it("includes every connected environment with one-click updates, remote ones too", () => {
    const plan = planProviderUpdates([
      {
        environmentId: local,
        label: "macOS",
        connected: true,
        providers: [provider({ driver: codex })],
      },
      {
        environmentId: ssh,
        label: "devbox",
        connected: true,
        providers: [provider({ driver: codex }), provider({ driver: claude })],
      },
      {
        environmentId: relay,
        label: "laptop",
        connected: true,
        providers: [provider({ driver: codex, status: "current" })],
      },
    ]);

    expect(
      plan.environments.map((environment) => ({
        environmentId: environment.environmentId,
        updates: environment.updates.map((candidate) => candidate.driver),
        skipped: environment.skipped,
      })),
    ).toEqual([
      { environmentId: local, updates: [codex], skipped: [] },
      { environmentId: ssh, updates: [codex, claude], skipped: [] },
    ]);
    expect(plan.disconnected).toEqual([]);
    expect(plan.updateCount).toBe(3);
  });

  it("omits disconnected environments from the run and names outdated ones as skipped", () => {
    const plan = planProviderUpdates([
      {
        environmentId: local,
        label: "macOS",
        connected: true,
        providers: [provider({ driver: codex })],
      },
      {
        environmentId: ssh,
        label: "devbox",
        connected: false,
        providers: [provider({ driver: claude })],
      },
      {
        environmentId: relay,
        label: "laptop",
        connected: false,
        providers: [provider({ driver: codex, status: "current" })],
      },
    ]);

    expect(plan.environments.map((environment) => environment.environmentId)).toEqual([local]);
    expect(plan.disconnected).toEqual([
      { environmentId: ssh, label: "devbox", providerNames: "Claude" },
    ]);
  });

  it("lists providers without a one-click update as skipped with the existing reason", () => {
    const manual = provider({ driver: claude, canUpdate: false });
    const running = provider({ driver: codex, updateState: updateState("running") });
    const plan = planProviderUpdates([
      { environmentId: ssh, label: "devbox", connected: true, providers: [manual, running] },
    ]);

    expect(plan.environments).toHaveLength(1);
    expect(plan.environments[0]!.updates).toEqual([]);
    expect(
      plan.environments[0]!.skipped.map((skip) => [skip.provider.driver, skip.reason]),
    ).toEqual([
      [claude, "Claude can be updated from provider settings."],
      [codex, "Codex is already updating."],
    ]);
    expect(plan.updateCount).toBe(0);
  });
});

describe("initialProviderUpdateAllRows", () => {
  it("queues environments with updates and marks the rest skipped with a reason", () => {
    const plan = planProviderUpdates([
      {
        environmentId: local,
        label: "macOS",
        connected: true,
        providers: [provider({ driver: codex })],
      },
      {
        environmentId: relay,
        label: "laptop",
        connected: true,
        providers: [provider({ driver: claude, canUpdate: false })],
      },
      {
        environmentId: ssh,
        label: "devbox",
        connected: false,
        providers: [provider({ driver: codex })],
      },
    ]);

    expect(initialProviderUpdateAllRows(plan)).toEqual([
      {
        environmentId: local,
        label: "macOS",
        providerNames: "Codex",
        status: "queued",
        message: null,
      },
      {
        environmentId: relay,
        label: "laptop",
        providerNames: "Claude",
        status: "skipped",
        message: "Claude can be updated from provider settings.",
      },
      {
        environmentId: ssh,
        label: "devbox",
        providerNames: "Codex",
        status: "skipped",
        message: DISCONNECTED_ENVIRONMENT_REASON,
      },
    ]);
  });
});

describe("providerUpdateAllOutcome", () => {
  const targets = [
    provider({ driver: codex, instanceId: "codex-ssh" }),
  ] as ProviderUpdateCandidate[];

  it("reports an update the server confirmed", () => {
    expect(
      providerUpdateAllOutcome(targets, [
        success([
          provider({
            driver: codex,
            instanceId: "codex-ssh",
            updateState: updateState("succeeded"),
          }),
        ]),
      ]),
    ).toEqual({ status: "updated", message: null });
  });

  it("reports the server's failed and unchanged messages", () => {
    expect(
      providerUpdateAllOutcome(targets, [
        success([
          provider({
            driver: codex,
            instanceId: "codex-ssh",
            updateState: updateState("failed", "npm exited with 1."),
          }),
        ]),
      ]),
    ).toMatchObject({ status: "failed", message: expect.stringContaining("npm exited with 1.") });
    expect(
      providerUpdateAllOutcome(targets, [
        success([
          provider({
            driver: codex,
            instanceId: "codex-ssh",
            updateState: updateState("unchanged", "Codex still reports 1.0.0."),
          }),
        ]),
      ]),
    ).toEqual({ status: "unchanged", message: "Codex still reports 1.0.0." });
  });

  it("reports the RPC error of a failed command", () => {
    expect(providerUpdateAllOutcome(targets, [failure("Permission denied.")])).toEqual({
      status: "failed",
      message: "Permission denied.",
    });
  });

  it("never reports an interrupted or unconfirmed command as updated", () => {
    expect(providerUpdateAllOutcome(targets, [interrupted()])).toEqual({
      status: "unchanged",
      message: "Could not confirm the update finished. Refresh provider status to check.",
    });
    expect(providerUpdateAllOutcome(targets, [success([])])).toEqual({
      status: "unchanged",
      message: "Could not confirm the update finished. Refresh provider status to check.",
    });
  });
});

describe("runProviderUpdatePlan", () => {
  function plan(environmentIds: ReadonlyArray<EnvironmentId>) {
    return planProviderUpdates(
      environmentIds.map((environmentId) => ({
        environmentId,
        label: environmentId,
        connected: true,
        providers: [provider({ driver: codex, instanceId: `codex-${environmentId}` })],
      })),
    );
  }

  it("sends each environment's own id and keeps going after one environment fails", async () => {
    const calls: Array<[EnvironmentId, string]> = [];
    const published: Array<[EnvironmentId, ProviderUpdateAllStatus, string | null]> = [];

    await runProviderUpdatePlan({
      plan: plan([ssh, relay]),
      update: async (environmentId, candidate) => {
        calls.push([environmentId, candidate.instanceId]);
        return environmentId === ssh
          ? failure("ssh: connection reset")
          : success([
              provider({
                driver: codex,
                instanceId: candidate.instanceId,
                updateState: updateState("succeeded"),
              }),
            ]);
      },
      publish: (environmentId, status, message) => published.push([environmentId, status, message]),
    });

    expect(calls).toEqual([
      [ssh, "codex-ssh-devbox"],
      [relay, "codex-relay-laptop"],
    ]);
    expect(published).toContainEqual([ssh, "failed", "ssh: connection reset"]);
    expect(published).toContainEqual([relay, "updated", null]);
  });

  it("treats a dispatcher that throws as a failure of that environment only", async () => {
    const published: Array<[EnvironmentId, ProviderUpdateAllStatus, string | null]> = [];

    await runProviderUpdatePlan({
      plan: plan([ssh, relay]),
      update: async (environmentId, candidate) => {
        if (environmentId === ssh) throw new Error("socket closed");
        return success([
          provider({
            driver: codex,
            instanceId: candidate.instanceId,
            updateState: updateState("succeeded"),
          }),
        ]);
      },
      publish: (environmentId, status, message) => published.push([environmentId, status, message]),
    });

    expect(published).toContainEqual([ssh, "failed", "socket closed"]);
    expect(published).toContainEqual([relay, "updated", null]);
  });

  it("runs at most two environments at a time and starts the next as one settles", async () => {
    const third = EnvironmentId.make("third");
    const pending = new Map<
      EnvironmentId,
      ReturnType<typeof deferred<ProviderUpdateCommandResult>>
    >();
    const statuses = new Map<EnvironmentId, ProviderUpdateAllStatus>();
    const run = runProviderUpdatePlan({
      plan: plan([ssh, relay, third]),
      update: (environmentId) => {
        const next = deferred<ProviderUpdateCommandResult>();
        pending.set(environmentId, next);
        return next.promise;
      },
      publish: (environmentId, status) => statuses.set(environmentId, status),
    });
    await Promise.resolve();

    expect([...pending.keys()]).toEqual([ssh, relay]);
    expect(statuses.get(third)).toBeUndefined();

    pending.get(ssh)!.resolve(success([]));
    await waitUntil(() => pending.has(third));
    expect(statuses.get(third)).toBe("updating");

    pending.get(relay)!.resolve(success([]));
    pending.get(third)!.resolve(success([]));
    await run;
    expect(statuses.get(third)).toBe("unchanged");
  });
});

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50 && !condition(); attempt += 1) {
    await Promise.resolve();
  }
  expect(condition()).toBe(true);
}
