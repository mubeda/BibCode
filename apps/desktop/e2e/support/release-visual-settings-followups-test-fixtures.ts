// @effect-diagnostics nodeBuiltinImport:off - Real decoded public contracts and inert owned physical observations only.
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import * as NodeFS from "node:fs";
import { ExecutionEnvironmentDescriptor } from "../../../../packages/contracts/src/environment.ts";
import {
  ServerConfig,
  ServerTraceDiagnosticsResult,
  ServerProcessDiagnosticsResult,
} from "../../../../packages/contracts/src/server.ts";
import { ServerProviderUsageResult } from "../../../../packages/contracts/src/providerUsage.ts";
import { GitManagerOperationError } from "../../../../packages/contracts/src/gitManager.ts";
import { DEFAULT_SERVER_SETTINGS } from "../../../../packages/contracts/src/settings.ts";
import { OrchestrationReadModel } from "../../../../packages/contracts/src/orchestration.ts";
import type { SettingsFollowupSourceInput } from "./release-visual-settings-followups-source.ts";
const Schema = NodeModule.createRequire(
  new NodeURL.URL("../../../../packages/contracts/package.json", import.meta.url),
)("effect/Schema");
const time = "2026-10-06T00:00:00Z";
const serverVersion: string = JSON.parse(
  NodeFS.readFileSync(
    new NodeURL.URL("../../../../apps/server/package.json", import.meta.url),
    "utf8",
  ),
).version;
export function settingsSourceFixture(
  kind: "primary" | "remote" = "primary",
): SettingsFollowupSourceInput {
  const projectRoot = kind === "remote" ? "/owned/remote" : "/owned/project";
  const descriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor)({
    environmentId: "local",
    label: kind === "remote" ? "Owned reported remote" : "Owned server",
    platform: { os: "linux", arch: "x64" },
    serverVersion,
    storageInstanceId: kind === "remote" ? "remote-store" : "owned-store",
    bootId: kind === "remote" ? "remote-boot" : "owned-boot",
    capabilities: {},
  });
  const config = Schema.decodeUnknownSync(Schema.toCodecJson(ServerConfig))(
    Schema.encodeSync(Schema.toCodecJson(ServerConfig))({
      environment: descriptor,
      auth: {
        policy: "loopback-browser",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["bearer-access-token"],
        sessionCookieName: "owned",
      },
      cwd: projectRoot,
      keybindingsConfigPath: "/owned/keys.json",
      keybindings: [],
      issues: [],
      providers: [],
      availableEditors: [],
      observability: {
        logsDirectoryPath: "/owned/logs",
        localTracingEnabled: true,
        otlpTracesEnabled: false,
        otlpMetricsEnabled: false,
      },
      settings: DEFAULT_SERVER_SETTINGS,
    }),
  );
  const snapshot = Schema.decodeUnknownSync(OrchestrationReadModel)({
    snapshotSequence: 0,
    updatedAt: time,
    projects: [
      {
        id: "owned-project",
        title: "Owned project",
        workspaceRoot: projectRoot,
        defaultModelSelection: null,
        scripts: [],
        createdAt: time,
        updatedAt: time,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: "owned-thread",
        projectId: "owned-project",
        title: "Owned thread",
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        branch: "main",
        worktreePath: null,
        latestTurn: null,
        createdAt: time,
        updatedAt: time,
        deletedAt: null,
        messages: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
  });
  const physical = {
    path: projectRoot,
    branch: "main",
    commonDirectory: projectRoot + "/.git",
    headSha: "a".repeat(40),
  };
  return {
    target: {
      environmentId: kind === "remote" ? "remote:remote-store" : "local",
      ownedRoot: "/owned",
      descriptor,
      projectId: "owned-project",
      projectTitle: "Owned project",
      projectRoot,
      repositoryIdentity: null,
      threadId: "owned-thread",
      workspaceKind: "primary",
      physical: { ...physical },
    },
    config,
    snapshot,
    physical,
  };
}
export function settingsUsageFixture(kind = "available") {
  const window = (usedPercent: number, windowMinutes: number) => ({
    usedPercent,
    windowMinutes,
    resetsAt: "2026-10-06T01:00:00Z",
    resetDescription: null,
  });
  return Schema.decodeUnknownSync(Schema.toCodecJson(ServerProviderUsageResult))({
    readAt: time,
    isFetching: false,
    providers: [
      {
        provider: "codex",
        status: kind === "available" ? "ok" : "unavailable",
        session: kind === "available" ? window(7, 300) : null,
        weekly: kind === "available" ? window(41, 10080) : null,
        fableWeekly: null,
        planType: null,
        rateLimitResetCredits: null,
        updatedAt: time,
        error: kind === "available" ? null : "Codex not signed in.",
        metadata: kind === "available" ? { source: "app-server" } : {},
      },
    ],
  });
}
export function settingsDiagnosticsFixture() {
  const cause =
    "Could not start git because a required file or directory was not found. Check that the executable is available to this environment and that the repository folder is accessible.";
  const wire = {
    traceFilePath: "/owned/logs/trace.ndjson",
    scannedFilePaths: ["/owned/logs/trace.ndjson"],
    readAt: time,
    recordCount: 3,
    parseErrorCount: 0,
    firstSpanAt: { _tag: "None" },
    lastSpanAt: { _tag: "None" },
    failureCount: 1,
    interruptionCount: 0,
    slowSpanThresholdMs: 500,
    slowSpanCount: 0,
    logLevelCounts: {},
    topSpansByCount: [
      {
        name: "agent_activity_disabled",
        count: 2,
        failureCount: 0,
        measuredCount: 0,
        totalDurationMs: 0,
        averageDurationMs: 0,
        maxDurationMs: 0,
      },
    ],
    slowestSpans: [],
    commonFailures: [],
    latestFailures: [
      {
        name: "gitManager.getRefs",
        durationMs: 0.7,
        durationMeasured: true,
        endedAt: time,
        traceId: "new-trace",
        spanId: "new-span",
        cause,
      },
    ],
    latestWarningAndErrorLogs: [],
    partialFailure: { _tag: "None" },
    error: { _tag: "None" },
  };
  const after = Schema.decodeUnknownSync(Schema.toCodecJson(ServerTraceDiagnosticsResult))(wire),
    before = Schema.decodeUnknownSync(Schema.toCodecJson(ServerTraceDiagnosticsResult))({
      ...wire,
      recordCount: 2,
      failureCount: 0,
      latestFailures: [],
    });
  const processes = Schema.decodeUnknownSync(Schema.toCodecJson(ServerProcessDiagnosticsResult))({
    serverPid: 1,
    readAt: time,
    totals: {
      combined: { cpuPercent: 1, rssBytes: 1000, processCount: 1 },
      core: { cpuPercent: 1, rssBytes: 1000, processCount: 1 },
      external: { cpuPercent: 0, rssBytes: 0, processCount: 0 },
    },
    uiCoverage: { status: "notApplicable", message: { _tag: "None" } },
    processes: [
      {
        pid: 1,
        ppid: 0,
        pgid: { _tag: "None" },
        status: "Running",
        cpuPercent: 1,
        rssBytes: 1000,
        elapsed: "1s",
        command: "Owned server",
        depth: 0,
        childPids: [],
        processKey: "owned-key",
        scope: "core",
        kind: "server",
        label: "Owned server",
        confidence: "exact",
      },
    ],
    error: { _tag: "None" },
  });
  const error = Schema.decodeUnknownSync(GitManagerOperationError)({
    _tag: "GitManagerOperationError",
    operation: "gitManager.getRefs",
    code: "git-command-failed",
    message: cause,
    blocked: null,
  });
  return { before, after, processes, error, ownedServerPid: 1 };
}
