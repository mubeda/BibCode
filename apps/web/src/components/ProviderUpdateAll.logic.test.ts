import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type RemoteUpdateSnapshot,
  type ServerProvider,
} from "@bibcode/contracts";
import type { RemoteUpdateRunState } from "@bibcode/client-runtime/state/remoteUpdateCoordinator";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  DISCONNECTED_ENVIRONMENT_REASON,
  MANUAL_SERVER_UPDATE_REASON,
  PROVIDER_UPDATE_EXPIRY_MS,
  SERVER_INSTALL_EXPIRY_MS,
  applyProviderUpdateAllPublish,
  initialProviderUpdateAllRows,
  planProviderUpdates,
  providerUpdateAllOutcome,
  runProviderUpdatePlan,
  serverInstallOutcome,
  type ProviderUpdateAllStatus,
  type ProviderUpdateAllSubject,
  type ProviderUpdateCommandResult,
  type ServerUpdateInput,
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

function serverSnapshot(overrides: Partial<RemoteUpdateSnapshot> = {}): RemoteUpdateSnapshot {
  return {
    serverVersion: "0.11.0",
    latestVersion: "0.12.0",
    state: "update-available",
    error: null,
    support: { installMode: "interactive", reason: "available", installKind: "unknown" },
    downloadPercent: null,
    targetVersion: "0.12.0",
    installStage: null,
    ...overrides,
  };
}

function serverUpdate(overrides: Partial<RemoteUpdateSnapshot> = {}): ServerUpdateInput {
  return { progress: true, snapshot: serverSnapshot(overrides) };
}

const manualServer = serverUpdate({
  latestVersion: null,
  state: "idle",
  support: { installMode: "manual", reason: "manual-update-required", installKind: "archive" },
  targetVersion: null,
});

type Published = [EnvironmentId, ProviderUpdateAllSubject, ProviderUpdateAllStatus, string | null];

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

  it("plans a remote server install with an update available, alongside its providers", () => {
    const plan = planProviderUpdates([
      {
        environmentId: ssh,
        label: "devbox",
        connected: true,
        providers: [provider({ driver: codex })],
        serverUpdate: serverUpdate(),
      },
      {
        environmentId: relay,
        label: "laptop",
        connected: true,
        providers: [provider({ driver: codex, status: "current" })],
        serverUpdate: serverUpdate({ latestVersion: "0.12.1", targetVersion: "0.12.1" }),
      },
    ]);

    expect(
      plan.environments.map((environment) => [environment.environmentId, environment.server]),
    ).toEqual([
      [ssh, { kind: "install", targetVersion: "0.12.0", progress: true }],
      [relay, { kind: "install", targetVersion: "0.12.1", progress: true }],
    ]);
    expect(plan.environments[1]!.updates).toEqual([]);
    expect(plan.updateCount).toBe(1);
    expect(plan.serverInstallCount).toBe(2);
  });

  it("lists a manual host as skipped with the manual copy, and only beside provider work", () => {
    const plan = planProviderUpdates([
      {
        environmentId: ssh,
        label: "devbox",
        connected: true,
        providers: [provider({ driver: codex })],
        serverUpdate: manualServer,
      },
      {
        environmentId: relay,
        label: "laptop",
        connected: true,
        providers: [provider({ driver: codex, status: "current" })],
        serverUpdate: manualServer,
      },
    ]);

    expect(MANUAL_SERVER_UPDATE_REASON).toBe("This server must be updated manually.");
    expect(plan.environments.map((environment) => environment.environmentId)).toEqual([ssh]);
    expect(plan.environments[0]!.server).toEqual({
      kind: "skipped",
      reason: MANUAL_SERVER_UPDATE_REASON,
    });
    expect(plan.serverInstallCount).toBe(0);
  });

  it("plans no server install without an available update, a snapshot, or a connection", () => {
    const plan = planProviderUpdates([
      // The primary and desktop-local environments never carry server update facts.
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
        providers: [provider({ driver: codex })],
        serverUpdate: serverUpdate({ state: "up-to-date", latestVersion: "0.11.0" }),
      },
      {
        environmentId: relay,
        label: "laptop",
        connected: true,
        providers: [provider({ driver: codex })],
        serverUpdate: { progress: false, snapshot: null },
      },
      {
        environmentId: EnvironmentId.make("offline"),
        label: "offline",
        connected: false,
        providers: [provider({ driver: codex, status: "current" })],
        serverUpdate: serverUpdate(),
      },
    ]);

    expect(plan.environments.map((environment) => environment.server)).toEqual([null, null, null]);
    expect(plan.disconnected).toEqual([]);
    expect(plan.serverInstallCount).toBe(0);
  });

  it("holds a server install back while one of its providers is already updating", () => {
    const plan = planProviderUpdates([
      {
        environmentId: ssh,
        label: "devbox",
        connected: true,
        providers: [provider({ driver: codex, updateState: updateState("running") })],
        serverUpdate: serverUpdate(),
      },
    ]);

    expect(plan.environments[0]!.server).toEqual({
      kind: "skipped",
      reason: "Codex is still updating. Update this server once it finishes.",
    });
    expect(plan.serverInstallCount).toBe(0);
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
        subject: "providers",
        label: "macOS",
        detail: "Codex",
        status: "queued",
        message: null,
      },
      {
        environmentId: relay,
        subject: "providers",
        label: "laptop",
        detail: "Claude",
        status: "skipped",
        message: "Claude can be updated from provider settings.",
      },
      {
        environmentId: ssh,
        subject: "providers",
        label: "devbox",
        detail: "Codex",
        status: "skipped",
        message: DISCONNECTED_ENVIRONMENT_REASON,
      },
    ]);
  });

  it("adds a server row after an environment's providers", () => {
    const plan = planProviderUpdates([
      {
        environmentId: ssh,
        label: "devbox",
        connected: true,
        providers: [provider({ driver: codex })],
        serverUpdate: serverUpdate(),
      },
      {
        environmentId: relay,
        label: "laptop",
        connected: true,
        providers: [provider({ driver: claude })],
        serverUpdate: manualServer,
      },
    ]);

    expect(
      initialProviderUpdateAllRows(plan).map((row) => [
        row.environmentId,
        row.subject,
        row.detail,
        row.status,
        row.message,
      ]),
    ).toEqual([
      [ssh, "providers", "Codex", "queued", null],
      [ssh, "server", "Server v0.12.0", "queued", null],
      [relay, "providers", "Claude", "queued", null],
      [relay, "server", "Server", "skipped", MANUAL_SERVER_UPDATE_REASON],
    ]);
  });
});

describe("applyProviderUpdateAllPublish", () => {
  const rows = initialProviderUpdateAllRows(
    planProviderUpdates([
      {
        environmentId: ssh,
        label: "devbox",
        connected: true,
        providers: [provider({ driver: codex })],
        serverUpdate: serverUpdate(),
      },
    ]),
  );

  it("updates only the row for that environment and subject", () => {
    expect(
      applyProviderUpdateAllPublish(
        rows,
        { environmentId: ssh, subject: "server" },
        "updating",
        null,
      )?.map((row) => row.status),
    ).toEqual(["queued", "updating"]);
  });

  it("leaves a cleared summary cleared", () => {
    expect(
      applyProviderUpdateAllPublish(
        null,
        { environmentId: ssh, subject: "providers" },
        "updated",
        null,
      ),
    ).toBeNull();
  });
});

describe("serverInstallOutcome", () => {
  function run(state: RemoteUpdateRunState) {
    return serverInstallOutcome("devbox", AsyncResult.success(state));
  }

  it("names the installed version, an up-to-date host, and the coordinator's failure", () => {
    expect(run({ phase: "succeeded", version: "0.12.0" })).toEqual({
      status: "updated",
      message: "Updated to v0.12.0",
    });
    expect(run({ phase: "up-to-date" })).toEqual({
      status: "unchanged",
      message: "Already up to date",
    });
    expect(run({ phase: "failed", failure: { kind: "not-back" } })).toEqual({
      status: "failed",
      message:
        "devbox hasn't come back after the update. Check BiBCode on devbox; it may be on a different port.",
    });
  });

  it("never reports an interrupted install as updated", () => {
    expect(serverInstallOutcome("devbox", AsyncResult.failure(Cause.interrupt()))).toEqual({
      status: "unchanged",
      message: "Could not confirm the server update finished. Check it in Settings → Connections.",
    });
    expect(
      serverInstallOutcome("devbox", AsyncResult.failure(Cause.fail(new Error("socket closed")))),
    ).toEqual({ status: "failed", message: "socket closed" });
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

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends each environment's own id and keeps going after one environment fails", async () => {
    const calls: Array<[EnvironmentId, string]> = [];
    const published: Published[] = [];

    await runProviderUpdatePlan({
      plan: plan([ssh, relay]),
      installServer: vi.fn(),
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
      publish: (target, status, message) =>
        published.push([target.environmentId, target.subject, status, message]),
    });

    expect(calls).toEqual([
      [ssh, "codex-ssh-devbox"],
      [relay, "codex-relay-laptop"],
    ]);
    expect(published).toContainEqual([ssh, "providers", "failed", "ssh: connection reset"]);
    expect(published).toContainEqual([relay, "providers", "updated", null]);
  });

  it("treats a dispatcher that throws as a failure of that environment only", async () => {
    const published: Published[] = [];

    await runProviderUpdatePlan({
      plan: plan([ssh, relay]),
      installServer: vi.fn(),
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
      publish: (target, status, message) =>
        published.push([target.environmentId, target.subject, status, message]),
    });

    expect(published).toContainEqual([ssh, "providers", "failed", "socket closed"]);
    expect(published).toContainEqual([relay, "providers", "updated", null]);
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
      installServer: vi.fn(),
      update: (environmentId) => {
        const next = deferred<ProviderUpdateCommandResult>();
        pending.set(environmentId, next);
        return next.promise;
      },
      publish: (target, status) => statuses.set(target.environmentId, status),
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

  function updatedResult(instanceId: string): ProviderUpdateCommandResult {
    return success([
      provider({ driver: codex, instanceId, updateState: updateState("succeeded") }),
    ]);
  }

  function serverPlan(
    environments: ReadonlyArray<{
      readonly environmentId: EnvironmentId;
      readonly providers: boolean;
    }>,
  ) {
    return planProviderUpdates(
      environments.map(({ environmentId, providers }) => ({
        environmentId,
        label: environmentId,
        connected: true,
        providers: [
          provider({
            driver: codex,
            instanceId: `codex-${environmentId}`,
            ...(providers ? {} : { status: "current" as const }),
          }),
        ],
        serverUpdate: serverUpdate(),
      })),
    );
  }

  it("never starts a server install while that environment's provider update is in flight", async () => {
    const pending = deferred<ProviderUpdateCommandResult>();
    const installServer = vi.fn(async () => ({ status: "updated" as const, message: null }));
    const published: Published[] = [];
    const run = runProviderUpdatePlan({
      plan: serverPlan([{ environmentId: ssh, providers: true }]),
      update: () => pending.promise,
      installServer,
      publish: (target, status, message) =>
        published.push([target.environmentId, target.subject, status, message]),
    });
    for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();

    expect(installServer).not.toHaveBeenCalled();
    expect(published).toEqual([[ssh, "providers", "updating", null]]);

    pending.resolve(updatedResult(`codex-${ssh}`));
    await run;

    expect(installServer).toHaveBeenCalledTimes(1);
    expect(installServer).toHaveBeenCalledWith(ssh, {
      kind: "install",
      targetVersion: "0.12.0",
      progress: true,
    });
    expect(published).toEqual([
      [ssh, "providers", "updating", null],
      [ssh, "providers", "updated", null],
      [ssh, "server", "updating", null],
      [ssh, "server", "updated", null],
    ]);
  });

  it("restarts no environment whose provider update failed and still installs where it succeeded", async () => {
    const installServer = vi.fn(async (_environmentId: EnvironmentId) => ({
      status: "updated" as const,
      message: null,
    }));
    const published: Published[] = [];

    await runProviderUpdatePlan({
      plan: serverPlan([
        { environmentId: ssh, providers: true },
        { environmentId: relay, providers: true },
      ]),
      update: async (environmentId, candidate) =>
        environmentId === ssh
          ? failure("npm: permission denied")
          : updatedResult(candidate.instanceId),
      installServer,
      publish: (target, status, message) =>
        published.push([target.environmentId, target.subject, status, message]),
    });

    expect(installServer.mock.calls.map(([environmentId]) => environmentId)).toEqual([relay]);
    expect(published).toContainEqual([
      ssh,
      "server",
      "skipped",
      "Not restarted because its providers did not update.",
    ]);
    expect(published).toContainEqual([relay, "server", "updated", null]);
  });

  it("restarts no environment whose provider update did not confirm", async () => {
    const installServer = vi.fn(async () => ({ status: "updated" as const, message: null }));
    const published: Published[] = [];

    await runProviderUpdatePlan({
      plan: serverPlan([{ environmentId: ssh, providers: true }]),
      update: async () => interrupted(),
      installServer,
      publish: (target, status, message) =>
        published.push([target.environmentId, target.subject, status, message]),
    });

    expect(installServer).not.toHaveBeenCalled();
    expect(published.at(-1)).toEqual([
      ssh,
      "server",
      "skipped",
      "Not restarted because its providers did not update.",
    ]);
  });

  it("installs a server that has no provider updates without waiting on any", async () => {
    const update = vi.fn();
    const installServer = vi.fn(async () => ({
      status: "failed" as const,
      message: "devbox hasn't come back after the update.",
    }));
    const published: Published[] = [];

    await runProviderUpdatePlan({
      plan: serverPlan([{ environmentId: ssh, providers: false }]),
      update,
      installServer,
      publish: (target, status, message) =>
        published.push([target.environmentId, target.subject, status, message]),
    });

    expect(update).not.toHaveBeenCalled();
    expect(published).toEqual([
      [ssh, "server", "updating", null],
      [ssh, "server", "failed", "devbox hasn't come back after the update."],
    ]);
  });

  it("gives up on provider updates that never settle and does not restart that server", async () => {
    vi.useFakeTimers();
    const installServer = vi.fn(async () => ({ status: "updated" as const, message: null }));
    const published: Published[] = [];
    let finished = false;
    const run = runProviderUpdatePlan({
      plan: serverPlan([{ environmentId: ssh, providers: true }]),
      // A socket that died without a close event: the command never settles.
      update: () => new Promise<ProviderUpdateCommandResult>(() => {}),
      installServer,
      publish: (target, status, message) =>
        published.push([target.environmentId, target.subject, status, message]),
    }).then(() => {
      finished = true;
    });

    await vi.advanceTimersByTimeAsync(PROVIDER_UPDATE_EXPIRY_MS - 1);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await run;

    expect(installServer).not.toHaveBeenCalled();
    expect(published).toEqual([
      [ssh, "providers", "updating", null],
      [
        ssh,
        "providers",
        "unchanged",
        "Could not confirm the update finished. Refresh provider status to check.",
      ],
      [ssh, "server", "skipped", "Not restarted because its providers did not update."],
    ]);
  });

  it("gives up on a server install that never settles", async () => {
    vi.useFakeTimers();
    const published: Published[] = [];
    const run = runProviderUpdatePlan({
      plan: serverPlan([{ environmentId: ssh, providers: false }]),
      update: vi.fn(),
      installServer: () => new Promise(() => {}),
      publish: (target, status, message) =>
        published.push([target.environmentId, target.subject, status, message]),
    });

    await vi.advanceTimersByTimeAsync(SERVER_INSTALL_EXPIRY_MS);
    await run;

    expect(published.at(-1)).toEqual([
      ssh,
      "server",
      "unchanged",
      "Could not confirm the server update finished. Check it in Settings → Connections.",
    ]);
  });
});

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50 && !condition(); attempt += 1) {
    await Promise.resolve();
  }
  expect(condition()).toBe(true);
}
