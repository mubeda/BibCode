// @effect-diagnostics nodeBuiltinImport:off - Independent owned Git observations remain private and read-only.
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import type {
  ExecutionEnvironmentDescriptor,
  RepositoryIdentity,
} from "../../../../packages/contracts/src/environment.ts";
import type {
  ServerConfig,
  ServerTraceDiagnosticsResult,
  ServerProcessDiagnosticsResult,
} from "../../../../packages/contracts/src/server.ts";
import type { ServerProviderUsageResult } from "../../../../packages/contracts/src/providerUsage.ts";
import type { GitManagerOperationError } from "../../../../packages/contracts/src/gitManager.ts";
import type { OrchestrationReadModel } from "../../../../packages/contracts/src/orchestration.ts";
import { remoteEnvironmentId } from "../../../../packages/client-runtime/src/connection/remoteIdentity.ts";
export interface SettingsFollowupPhysicalSource {
  readonly path: string;
  readonly branch: string;
  readonly commonDirectory: string;
  readonly headSha: string;
}
export interface SettingsFollowupTarget {
  readonly environmentId: string;
  readonly ownedRoot: string;
  readonly descriptor: ExecutionEnvironmentDescriptor;
  readonly projectId: string;
  readonly projectTitle: string;
  readonly projectRoot: string;
  readonly repositoryIdentity: RepositoryIdentity | null;
  readonly threadId: string;
  readonly workspaceKind: "primary" | "worktree";
  readonly physical: SettingsFollowupPhysicalSource;
}
export interface SettingsFollowupSourceInput {
  readonly target: SettingsFollowupTarget;
  readonly config: ServerConfig;
  readonly snapshot: OrchestrationReadModel;
  readonly physical: SettingsFollowupPhysicalSource;
}
export function verifySettingsFollowupSource(input: SettingsFollowupSourceInput) {
  const refused = () => new Error("Owned settings source refused.");
  const { target, config, snapshot, physical } = input,
    expected = target.descriptor,
    actual = config.environment;
  const projects = snapshot.projects.filter((value) => value.id === target.projectId),
    threads = snapshot.threads.filter((value) => value.id === target.threadId);
  const paths = [
    target.ownedRoot,
    target.projectRoot,
    target.physical.path,
    target.physical.commonDirectory,
    physical.path,
    physical.commonDirectory,
  ];
  if (
    paths.some(
      (path) =>
        !NodePath.isAbsolute(path) ||
        NodePath.normalize(path) !== path ||
        path === NodePath.parse(path).root,
    )
  )
    throw refused();
  for (const path of paths.slice(1)) {
    const relative = NodePath.relative(target.ownedRoot, path);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(".." + NodePath.sep) ||
      NodePath.isAbsolute(relative)
    )
      throw refused();
  }
  if (
    expected.bootId === null ||
    expected.storageInstanceId === null ||
    actual.environmentId !== expected.environmentId ||
    actual.bootId !== expected.bootId ||
    actual.storageInstanceId !== expected.storageInstanceId ||
    actual.label !== expected.label ||
    expected.environmentId !== "local" ||
    (target.environmentId !== "local" &&
      target.environmentId !== remoteEnvironmentId(expected.storageInstanceId)) ||
    projects.length !== 1 ||
    threads.length !== 1
  )
    throw refused();
  const project = projects[0]!,
    thread = threads[0]!;
  const actualRepository = project.repositoryIdentity ?? null,
    expectedRepository = target.repositoryIdentity;
  if ((actualRepository === null) !== (expectedRepository === null)) throw refused();
  if (actualRepository !== null && expectedRepository !== null) {
    const fields = [
      "canonicalKey",
      "rootPath",
      "displayName",
      "provider",
      "owner",
      "name",
    ] as const;
    const locatorFields = ["source", "remoteName", "remoteUrl"] as const;
    if (
      fields.some((field) => actualRepository[field] !== expectedRepository[field]) ||
      locatorFields.some(
        (field) => actualRepository.locator[field] !== expectedRepository.locator[field],
      )
    )
      throw refused();
  }
  if (
    project.deletedAt !== null ||
    project.title !== target.projectTitle ||
    project.workspaceRoot !== target.projectRoot ||
    thread.deletedAt !== null ||
    thread.archivedAt !== null ||
    thread.projectId !== project.id ||
    (thread.kind ?? "workspace") !== "workspace" ||
    (target.workspaceKind === "primary"
      ? thread.worktreePath !== null || physical.path !== project.workspaceRoot
      : target.workspaceKind !== "worktree" || thread.worktreePath !== physical.path) ||
    thread.branch !== target.physical.branch ||
    (thread.worktreePath ?? project.workspaceRoot) !== target.physical.path ||
    physical.path !== target.physical.path ||
    physical.branch !== target.physical.branch ||
    physical.commonDirectory !== target.physical.commonDirectory ||
    physical.commonDirectory !== NodePath.join(target.projectRoot, ".git") ||
    !/^[a-f0-9]{40}$/.test(physical.headSha) ||
    physical.headSha !== target.physical.headSha
  )
    throw refused();
  return {
    environmentMatched: true,
    bootMatched: true,
    storageMatched: true,
    reportedLabelRetained: true,
    projectMatched: true,
    threadMatched: true,
    gitMatched: true,
  } as const;
}
export function verifySettingsFollowupUsage(
  source: ServerProviderUsageResult,
  kind: "available" | "unavailable",
): readonly string[] {
  const refused = () => new Error("Owned settings usage source refused.");
  const values = source.providers.filter((value) => value.provider === "codex");
  if (source.isFetching || values.length !== 1) throw refused();
  const codex = values[0]!;
  if (codex.fableWeekly !== null || codex.rateLimitResetCredits !== null) throw refused();
  if (kind === "unavailable") {
    if (
      codex.status !== "unavailable" ||
      codex.session !== null ||
      codex.weekly !== null ||
      codex.error !== "Codex not signed in."
    )
      throw refused();
    return [];
  }
  if (
    kind !== "available" ||
    codex.status !== "ok" ||
    codex.error !== null ||
    codex.metadata.source !== "app-server" ||
    codex.session?.usedPercent !== 7 ||
    codex.session.windowMinutes !== 300 ||
    codex.weekly?.usedPercent !== 41 ||
    codex.weekly.windowMinutes !== 10080
  )
    throw refused();
  const DateTime = NodeModule.createRequire(
    new NodeURL.URL("../../../../packages/contracts/package.json", import.meta.url),
  )("effect/DateTime");
  if (
    [codex.session, codex.weekly].some(
      (window) =>
        window.resetsAt === null ||
        DateTime.toEpochMillis(window.resetsAt) <= DateTime.toEpochMillis(source.readAt),
    )
  )
    throw refused();
  return ["93% remaining", "59% remaining"];
}
export function verifySettingsFollowupDiagnostics(input: {
  before: ServerTraceDiagnosticsResult;
  after: ServerTraceDiagnosticsResult;
  error: GitManagerOperationError;
  processes: ServerProcessDiagnosticsResult;
  ownedServerPid: number;
}) {
  const refused = () => new Error("Owned settings diagnostic source refused.");
  const { before, after, error, processes, ownedServerPid } = input;
  if (
    before.traceFilePath !== after.traceFilePath ||
    after.recordCount <= before.recordCount ||
    after.failureCount <= before.failureCount ||
    after.parseErrorCount !== 0 ||
    after.error._tag !== "None" ||
    after.partialFailure._tag !== "None" ||
    error.operation !== "gitManager.getRefs" ||
    error.blocked !== null
  )
    throw refused();
  const old = new Set(before.latestFailures.map((value) => value.traceId + ":" + value.spanId));
  const failures = after.latestFailures.filter(
    (value) =>
      value.name === error.operation &&
      value.cause === error.message &&
      value.durationMeasured === true &&
      !old.has(value.traceId + ":" + value.spanId),
  );
  const untimed = after.topSpansByCount.filter(
    (value) =>
      ["agent_activity_enabled", "agent_activity_disabled"].includes(value.name) &&
      value.count > 0 &&
      value.measuredCount === 0 &&
      value.totalDurationMs === 0 &&
      value.averageDurationMs === 0 &&
      value.maxDurationMs === 0,
  );
  if (
    failures.length !== 1 ||
    untimed.length !== 1 ||
    processes.serverPid !== ownedServerPid ||
    processes.error._tag !== "None" ||
    processes.processes.length === 0 ||
    processes.processes.length > 64
  )
    throw refused();
  const byPid = new Map(processes.processes.map((value) => [value.pid, value]));
  if (
    byPid.size !== processes.processes.length ||
    new Set(processes.processes.map((value) => value.processKey)).size !==
      processes.processes.length ||
    byPid.get(ownedServerPid)?.kind !== "server" ||
    processes.totals.combined.processCount !== processes.processes.length
  )
    throw refused();
  for (const process of processes.processes) {
    let current = process,
      steps = 0;
    while (current.pid !== ownedServerPid) {
      const parent = byPid.get(current.ppid);
      if (!parent || ++steps > byPid.size) throw refused();
      current = parent;
    }
  }
  const unmeasuredSpanName = untimed[0]!.name;
  if (
    unmeasuredSpanName !== "agent_activity_enabled" &&
    unmeasuredSpanName !== "agent_activity_disabled"
  )
    throw refused();
  return {
    spanCount: after.recordCount,
    failureCount: after.failureCount,
    unmeasuredSpanName,
    unmeasuredCount: untimed[0]!.count,
    failureCause: failures[0]!.cause,
    processLabels: processes.processes.map((value) => value.label),
  } as const;
}
