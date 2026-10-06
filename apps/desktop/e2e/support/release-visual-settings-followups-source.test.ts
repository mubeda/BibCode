// @effect-diagnostics nodeBuiltinImport:off - Real decoded public contracts and inert owned physical observations only.
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";
import { ExecutionEnvironmentDescriptor } from "../../../../packages/contracts/src/environment.ts";
import { OrchestrationReadModel } from "../../../../packages/contracts/src/orchestration.ts";
import {
  verifySettingsFollowupSource,
  verifySettingsFollowupUsage,
  verifySettingsFollowupDiagnostics,
} from "./release-visual-settings-followups-source.ts";
import {
  settingsSourceFixture,
  settingsUsageFixture,
  settingsDiagnosticsFixture,
} from "./release-visual-settings-followups-test-fixtures.ts";
const Schema = NodeModule.createRequire(
  new NodeURL.URL("../../../../packages/contracts/package.json", import.meta.url),
)("effect/Schema");
const time = "2026-10-06T00:00:00Z";

it("joins real decoded environment boot/storage, project/thread and independent physical Git observations", () => {
  expect(verifySettingsFollowupSource(settingsSourceFixture())).toEqual({
    environmentMatched: true,
    bootMatched: true,
    storageMatched: true,
    reportedLabelRetained: true,
    projectMatched: true,
    threadMatched: true,
    gitMatched: true,
  });
});
it("binds the client remote catalog key to storage while both real server descriptors report local", () => {
  const remote = settingsSourceFixture("remote");
  expect(remote.config.environment.environmentId).toBe("local");
  expect(remote.target.environmentId).toBe("remote:" + remote.target.descriptor.storageInstanceId);
  expect(() => verifySettingsFollowupSource(remote)).not.toThrow();
});
it("retains the current server-authored repository identity and refuses its drift on the same checkout", () => {
  const f = settingsSourceFixture();
  const identity = {
    canonicalKey: "source.visual.invalid/owned/settings",
    locator: {
      source: "git-remote" as const,
      remoteName: "origin",
      remoteUrl: "https://source.visual.invalid/owned/settings.git",
    },
    rootPath: "/owned/project",
    displayName: "settings",
    name: "settings",
    owner: "owned",
  };
  const target = { ...f.target, repositoryIdentity: identity };
  const snapshot = {
    ...f.snapshot,
    projects: [{ ...f.snapshot.projects[0]!, repositoryIdentity: identity }],
  };
  expect(() => verifySettingsFollowupSource({ ...f, target, snapshot })).not.toThrow();
  expect(() =>
    verifySettingsFollowupSource({
      ...f,
      target,
      snapshot: {
        ...snapshot,
        projects: [
          {
            ...snapshot.projects[0]!,
            repositoryIdentity: {
              ...identity,
              canonicalKey: "source.visual.invalid/foreign/settings",
            },
          },
        ],
      },
    }),
  ).toThrow();
  expect(() =>
    verifySettingsFollowupSource({
      ...f,
      target: { ...target, repositoryIdentity: null },
      snapshot,
    }),
  ).toThrow();
});
it("admits a registered linked worktree beside the primary inside the same owned root", () => {
  const f = settingsSourceFixture(),
    physical = { ...f.physical, path: "/owned/linked" };
  const snapshot = {
    ...f.snapshot,
    threads: [{ ...f.snapshot.threads[0]!, worktreePath: physical.path }],
  };
  expect(() =>
    verifySettingsFollowupSource({
      ...f,
      target: { ...f.target, physical, workspaceKind: "worktree" },
      snapshot,
      physical,
    }),
  ).not.toThrow();
});

it("joins available native windows and genuinely unavailable B without borrowing former A windows", () => {
  expect(verifySettingsFollowupUsage(settingsUsageFixture(), "available")).toEqual([
    "93% remaining",
    "59% remaining",
  ]);
  expect(verifySettingsFollowupUsage(settingsUsageFixture("unavailable"), "unavailable")).toEqual(
    [],
  );
  expect(() => verifySettingsFollowupUsage(settingsUsageFixture(), "unavailable")).toThrow();
  const changed = settingsUsageFixture();
  expect(() =>
    verifySettingsFollowupUsage(
      {
        ...changed,
        providers: [
          {
            ...changed.providers[0]!,
            rateLimitResetCredits: {
              availableCount: 1,
              totalEarnedCount: null,
              nextExpiresAt: null,
            },
          },
        ],
      },
      "available",
    ),
  ).toThrow();
});

it("joins the new actual read failure, genuine disabled startup unknown timing and owned live processes", () => {
  const f = settingsDiagnosticsFixture();
  expect(verifySettingsFollowupDiagnostics(f)).toMatchObject({
    spanCount: 3,
    failureCount: 1,
    unmeasuredSpanName: "agent_activity_disabled",
    failureCause: f.error.message,
    processLabels: ["Owned server"],
  });
});
it.each([
  "old-failure",
  "cause",
  "zero-timing",
  "foreign-server",
  "foreign-process",
  "duplicate-process",
])("refuses a %s diagnostic source join", (reason) => {
  const f = settingsDiagnosticsFixture();
  if (reason === "old-failure") f.before = f.after;
  if (reason === "cause")
    f.after = {
      ...f.after,
      latestFailures: [{ ...f.after.latestFailures[0]!, cause: "Foreign failure" }],
    };
  if (reason === "zero-timing")
    f.after = {
      ...f.after,
      topSpansByCount: [{ ...f.after.topSpansByCount[0]!, measuredCount: 2 }],
    };
  if (reason === "foreign-server") f.ownedServerPid = 2;
  if (reason === "foreign-process")
    f.processes = {
      ...f.processes,
      processes: [
        ...f.processes.processes,
        { ...f.processes.processes[0]!, pid: 2, ppid: 999, processKey: "foreign" },
      ],
    };
  if (reason === "duplicate-process")
    f.processes = {
      ...f.processes,
      processes: [...f.processes.processes, f.processes.processes[0]!],
    };
  expect(() => verifySettingsFollowupDiagnostics(f)).toThrow();
});
it.each([
  "environment",
  "boot",
  "storage",
  "reported-label",
  "project-root",
  "deleted-project",
  "duplicate-project",
  "thread-project",
  "deleted-thread",
  "archived-thread",
  "branch",
  "worktree",
  "physical-head",
  "physical-common",
  "physical-path",
])("refuses an otherwise valid %s source substitution", (reason) => {
  const input = settingsSourceFixture();
  let config = input.config,
    snapshot = input.snapshot,
    physical = input.physical;
  const project = snapshot.projects[0]!,
    thread = snapshot.threads[0]!;
  if (["environment", "boot", "storage", "reported-label"].includes(reason))
    config = {
      ...config,
      environment: Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor)({
        ...config.environment,
        ...(reason === "environment"
          ? { environmentId: "foreign" }
          : reason === "boot"
            ? { bootId: "foreign" }
            : reason === "storage"
              ? { storageInstanceId: "foreign" }
              : { label: "Foreign server" }),
      }),
    };
  if (reason === "project-root")
    snapshot = Schema.decodeUnknownSync(OrchestrationReadModel)({
      ...snapshot,
      projects: [{ ...project, workspaceRoot: "/foreign" }],
    });
  if (reason === "deleted-project")
    snapshot = Schema.decodeUnknownSync(OrchestrationReadModel)({
      ...snapshot,
      projects: [{ ...project, deletedAt: time }],
    });
  if (reason === "duplicate-project")
    snapshot = Schema.decodeUnknownSync(OrchestrationReadModel)({
      ...snapshot,
      projects: [project, project],
    });
  if (
    ["thread-project", "deleted-thread", "archived-thread", "branch", "worktree"].includes(reason)
  )
    snapshot = Schema.decodeUnknownSync(OrchestrationReadModel)({
      ...snapshot,
      threads: [
        {
          ...thread,
          ...(reason === "thread-project"
            ? { projectId: "foreign" }
            : reason === "deleted-thread"
              ? { deletedAt: time }
              : reason === "archived-thread"
                ? { archivedAt: time }
                : reason === "branch"
                  ? { branch: "foreign" }
                  : { worktreePath: "/foreign" }),
        },
      ],
    });
  if (reason === "physical-head") physical = { ...physical, headSha: "b".repeat(40) };
  if (reason === "physical-common") physical = { ...physical, commonDirectory: "/foreign/.git" };
  if (reason === "physical-path") physical = { ...physical, path: "/foreign" };
  expect(() => verifySettingsFollowupSource({ ...input, config, snapshot, physical })).toThrow();
});
