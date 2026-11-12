import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { ExecutionEnvironmentDescriptor } from "./environment.ts";
import { ServerAuthDescriptor } from "./auth.ts";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  KeybindingCommand,
  KeybindingValue,
  KeybindingWhen,
  ResolvedKeybindingsConfig,
} from "./keybindings.ts";
import { EditorId } from "./editor.ts";
import { ModelCapabilities } from "./model.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { ServerSettings } from "./settings.ts";

const KeybindingsMalformedConfigIssue = Schema.Struct({
  kind: Schema.Literal("keybindings.malformed-config"),
  message: TrimmedNonEmptyString,
});

const KeybindingsInvalidEntryIssue = Schema.Struct({
  kind: Schema.Literal("keybindings.invalid-entry"),
  message: TrimmedNonEmptyString,
  index: Schema.Finite,
});

export const ServerConfigIssue = Schema.Union([
  KeybindingsMalformedConfigIssue,
  KeybindingsInvalidEntryIssue,
]);
export type ServerConfigIssue = typeof ServerConfigIssue.Type;

const ServerConfigIssues = Schema.Array(ServerConfigIssue);

export const ServerProviderState = Schema.Literals(["ready", "warning", "error", "disabled"]);
export type ServerProviderState = typeof ServerProviderState.Type;

export const ServerProviderAuthStatus = Schema.Literals([
  "authenticated",
  "unauthenticated",
  "unknown",
]);
export type ServerProviderAuthStatus = typeof ServerProviderAuthStatus.Type;

export const ServerProviderAuth = Schema.Struct({
  status: ServerProviderAuthStatus,
  type: Schema.optional(TrimmedNonEmptyString),
  label: Schema.optional(TrimmedNonEmptyString),
  email: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderAuth = typeof ServerProviderAuth.Type;

export const ServerProviderModel = Schema.Struct({
  slug: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  resolvedModel: Schema.optional(TrimmedNonEmptyString),
  shortName: Schema.optional(TrimmedNonEmptyString),
  subProvider: Schema.optional(TrimmedNonEmptyString),
  isCustom: Schema.Boolean,
  capabilities: Schema.NullOr(ModelCapabilities),
});
export type ServerProviderModel = typeof ServerProviderModel.Type;

export const ServerProviderSlashCommandInput = Schema.Struct({
  hint: TrimmedNonEmptyString,
});
export type ServerProviderSlashCommandInput = typeof ServerProviderSlashCommandInput.Type;

export const ServerProviderSlashCommand = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  input: Schema.optional(ServerProviderSlashCommandInput),
});
export type ServerProviderSlashCommand = typeof ServerProviderSlashCommand.Type;

export const ServerProviderSkillInvocation = Schema.Literals(["dollar", "slash", "prompt"]);
export type ServerProviderSkillInvocation = typeof ServerProviderSkillInvocation.Type;

export const ServerProviderSkill = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  path: TrimmedNonEmptyString,
  scope: Schema.optional(TrimmedNonEmptyString),
  enabled: Schema.Boolean,
  displayName: Schema.optional(TrimmedNonEmptyString),
  shortDescription: Schema.optional(TrimmedNonEmptyString),
  invocation: Schema.optional(ServerProviderSkillInvocation),
});
export type ServerProviderSkill = typeof ServerProviderSkill.Type;

export const ServerProviderAgentInvocation = Schema.Literals(["mention"]);
export type ServerProviderAgentInvocation = typeof ServerProviderAgentInvocation.Type;

export const ServerProviderAgent = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  mode: Schema.optional(TrimmedNonEmptyString),
  invocation: Schema.optional(ServerProviderAgentInvocation),
});
export type ServerProviderAgent = typeof ServerProviderAgent.Type;

export const ServerProviderCapabilitiesInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  cwd: TrimmedNonEmptyString,
});
export type ServerProviderCapabilitiesInput = typeof ServerProviderCapabilitiesInput.Type;

export const ServerProviderCapabilities = Schema.Struct({
  slashCommands: Schema.Array(ServerProviderSlashCommand),
  skills: Schema.Array(ServerProviderSkill),
  agents: Schema.Array(ServerProviderAgent),
  issues: Schema.Array(TrimmedNonEmptyString),
});
export type ServerProviderCapabilities = typeof ServerProviderCapabilities.Type;

export class ServerProviderCapabilitiesError extends Schema.TaggedError<ServerProviderCapabilitiesError>()(
  "ServerProviderCapabilitiesError",
  { reason: TrimmedNonEmptyString },
) {
  override get message(): string {
    return this.reason;
  }
}

/**
 * Availability of a configured provider instance from the runtime's POV.
 *
 *  - `available` — the build ships this driver and an instance is wired
 *    up. Default for legacy snapshots produced from the closed
 *    `ServerSettings.providers` map.
 *  - `unavailable` — the user's `ServerSettings.providerInstances` (or a
 *    persisted thread / session binding) references a driver this build
 *    doesn't ship. Common after rolling back from a fork or PR branch
 *    that introduced a new driver. The snapshot is preserved so the UI
 *    can render "missing driver" affordances and so the data round-trips
 *    when the user moves back to the fork.
 *
 * Snapshots with `availability: "unavailable"` MUST set
 * `installed: false` and `enabled: false`; the runtime refuses turn
 * starts against them with a structured error.
 */
export const ServerProviderAvailability = Schema.Literals(["available", "unavailable"]);
export type ServerProviderAvailability = typeof ServerProviderAvailability.Type;

export const ServerProviderContinuation = Schema.Struct({
  groupKey: TrimmedNonEmptyString,
});
export type ServerProviderContinuation = typeof ServerProviderContinuation.Type;

export const ServerProviderVersionAdvisoryStatus = Schema.Literals([
  "unknown",
  "current",
  "behind_latest",
]);
export type ServerProviderVersionAdvisoryStatus = typeof ServerProviderVersionAdvisoryStatus.Type;

export const ServerProviderVersionAdvisory = Schema.Struct({
  status: ServerProviderVersionAdvisoryStatus,
  currentVersion: Schema.NullOr(TrimmedNonEmptyString),
  latestVersion: Schema.NullOr(TrimmedNonEmptyString),
  updateCommand: Schema.NullOr(TrimmedNonEmptyString),
  canUpdate: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  checkedAt: Schema.NullOr(IsoDateTime),
  message: Schema.NullOr(TrimmedNonEmptyString),
});
export type ServerProviderVersionAdvisory = typeof ServerProviderVersionAdvisory.Type;

export const ServerProviderUpdateStatus = Schema.Literals([
  "idle",
  "queued",
  "running",
  "succeeded",
  "failed",
  "unchanged",
]);
export type ServerProviderUpdateStatus = typeof ServerProviderUpdateStatus.Type;

export const ServerProviderUpdateState = Schema.Struct({
  status: ServerProviderUpdateStatus,
  startedAt: Schema.NullOr(IsoDateTime),
  finishedAt: Schema.NullOr(IsoDateTime),
  message: Schema.NullOr(TrimmedNonEmptyString),
  output: Schema.NullOr(Schema.String.check(Schema.isMaxLength(10_000))),
});
export type ServerProviderUpdateState = typeof ServerProviderUpdateState.Type;

export const ServerProvider = Schema.Struct({
  // Routing key for the configured instance this snapshot represents. This
  // is the only stable identity consumers may use for provider routing.
  instanceId: ProviderInstanceId,
  // Open driver kind slug that selects the implementation handling this
  // instance. It is metadata/capability context, not a routing key.
  driver: ProviderDriverKind,
  displayName: Schema.optional(TrimmedNonEmptyString),
  accentColor: Schema.optional(TrimmedNonEmptyString),
  badgeLabel: Schema.optional(TrimmedNonEmptyString),
  continuation: Schema.optional(ServerProviderContinuation),
  showInteractionModeToggle: Schema.optional(Schema.Boolean),
  requiresNewThreadForModelChange: Schema.optional(Schema.Boolean),
  supportsMcpStatus: Schema.optional(Schema.Boolean),
  supportsTurnSteer: Schema.optional(Schema.Boolean),
  supportsConversationRewind: Schema.optional(Schema.Boolean),
  supportsContextWindowUsage: Schema.optional(Schema.Boolean),
  /**
   * The server compacts this instance's conversations on request (`thread.compact`) and recovers
   * a turn that failed at the context limit. Absent from older servers, where the Compact action
   * sends `/compact` instead.
   */
  supportsCompaction: Schema.optional(Schema.Boolean),
  enabled: Schema.Boolean,
  installed: Schema.Boolean,
  version: Schema.NullOr(TrimmedNonEmptyString),
  status: ServerProviderState,
  auth: ServerProviderAuth,
  checkedAt: IsoDateTime,
  message: Schema.optional(TrimmedNonEmptyString),
  // Optional for back-compat: every legacy producer omits this field and
  // an absent value is interpreted as `"available"` by consumers (see
  // `isProviderAvailable`). New `ProviderInstanceRegistry` outputs set it
  // explicitly so the UI can render unavailable shadows from
  // `ServerSettings.providerInstances`.
  availability: Schema.optional(ServerProviderAvailability),
  // Human-readable reason populated when `availability === "unavailable"`.
  // Surfaces in the UI alongside the missing-driver affordance.
  unavailableReason: Schema.optional(TrimmedNonEmptyString),
  models: Schema.Array(ServerProviderModel),
  slashCommands: Schema.Array(ServerProviderSlashCommand).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  skills: Schema.Array(ServerProviderSkill).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  agents: Schema.Array(ServerProviderAgent).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  versionAdvisory: Schema.optionalKey(ServerProviderVersionAdvisory),
  updateState: Schema.optionalKey(ServerProviderUpdateState),
});
export type ServerProvider = typeof ServerProvider.Type;

export const ServerProviders = Schema.Array(ServerProvider);
export type ServerProviders = typeof ServerProviders.Type;

/**
 * A command-line tool BiBCode keeps up to date but that is not an agent provider (CodeGraph).
 * It shares the provider version advisory and update state, so the update notices, the pill and
 * "Update all" treat it like a provider, but it never appears in provider pickers or sessions.
 */
export const ServerTool = Schema.Struct({
  toolId: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  installed: Schema.Boolean,
  version: Schema.NullOr(TrimmedNonEmptyString),
  checkedAt: IsoDateTime,
  versionAdvisory: Schema.optionalKey(ServerProviderVersionAdvisory),
  updateState: Schema.optionalKey(ServerProviderUpdateState),
});
export type ServerTool = typeof ServerTool.Type;

export const ServerTools = Schema.Array(ServerTool);
export type ServerTools = typeof ServerTools.Type;

/**
 * Treat the optional `availability` as "available" when absent. This is
 * the rule legacy producers (which omit the field) and new producers
 * (which set it explicitly) agree on so consumers never have to thread
 * `?? "available"` defaults through their code paths.
 */
export const isProviderAvailable = (snapshot: ServerProvider): boolean =>
  snapshot.availability !== "unavailable";

export const ServerObservability = Schema.Struct({
  logsDirectoryPath: TrimmedNonEmptyString,
  localTracingEnabled: Schema.Boolean,
  otlpTracesEnabled: Schema.Boolean,
  otlpMetricsEnabled: Schema.Boolean,
});
export type ServerObservability = typeof ServerObservability.Type;

export const ServerTraceDiagnosticsErrorKind = Schema.Literals([
  "trace-file-not-found",
  "trace-file-read-failed",
]);
export type ServerTraceDiagnosticsErrorKind = typeof ServerTraceDiagnosticsErrorKind.Type;

export const ServerTraceDiagnosticsSpanSummary = Schema.Struct({
  name: TrimmedNonEmptyString,
  count: NonNegativeInt,
  failureCount: NonNegativeInt,
  /** Duration totals/averages include only these samples. Absent on older servers. */
  measuredCount: Schema.optional(NonNegativeInt),
  totalDurationMs: Schema.Finite,
  averageDurationMs: Schema.Finite,
  maxDurationMs: Schema.Finite,
});
export type ServerTraceDiagnosticsSpanSummary = typeof ServerTraceDiagnosticsSpanSummary.Type;

export const ServerTraceDiagnosticsFailureSummary = Schema.Struct({
  name: TrimmedNonEmptyString,
  cause: TrimmedNonEmptyString,
  count: NonNegativeInt,
  lastSeenAt: Schema.DateTimeUtc,
  traceId: TrimmedNonEmptyString,
  spanId: TrimmedNonEmptyString,
});
export type ServerTraceDiagnosticsFailureSummary = typeof ServerTraceDiagnosticsFailureSummary.Type;

export const ServerTraceDiagnosticsRecentFailure = Schema.Struct({
  name: TrimmedNonEmptyString,
  cause: TrimmedNonEmptyString,
  durationMs: Schema.Finite,
  /** False means the numeric compatibility value is not an elapsed measurement. */
  durationMeasured: Schema.optional(Schema.Boolean),
  endedAt: Schema.DateTimeUtc,
  traceId: TrimmedNonEmptyString,
  spanId: TrimmedNonEmptyString,
});
export type ServerTraceDiagnosticsRecentFailure = typeof ServerTraceDiagnosticsRecentFailure.Type;

export const ServerTraceDiagnosticsSpanOccurrence = Schema.Struct({
  name: TrimmedNonEmptyString,
  durationMs: Schema.Finite,
  /** Absent on older servers; an unmarked zero cannot establish measured timing. */
  durationMeasured: Schema.optional(Schema.Boolean),
  endedAt: Schema.DateTimeUtc,
  traceId: TrimmedNonEmptyString,
  spanId: TrimmedNonEmptyString,
});
export type ServerTraceDiagnosticsSpanOccurrence = typeof ServerTraceDiagnosticsSpanOccurrence.Type;

export const ServerTraceDiagnosticsLogEvent = Schema.Struct({
  spanName: TrimmedNonEmptyString,
  level: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
  seenAt: Schema.DateTimeUtc,
  traceId: TrimmedNonEmptyString,
  spanId: TrimmedNonEmptyString,
});
export type ServerTraceDiagnosticsLogEvent = typeof ServerTraceDiagnosticsLogEvent.Type;

export const ServerTraceDiagnosticsResult = Schema.Struct({
  traceFilePath: TrimmedNonEmptyString,
  scannedFilePaths: Schema.Array(TrimmedNonEmptyString),
  readAt: Schema.DateTimeUtc,
  recordCount: NonNegativeInt,
  parseErrorCount: NonNegativeInt,
  firstSpanAt: Schema.Option(Schema.DateTimeUtc),
  lastSpanAt: Schema.Option(Schema.DateTimeUtc),
  failureCount: NonNegativeInt,
  interruptionCount: NonNegativeInt,
  slowSpanThresholdMs: NonNegativeInt,
  slowSpanCount: NonNegativeInt,
  logLevelCounts: Schema.Record(TrimmedNonEmptyString, NonNegativeInt),
  topSpansByCount: Schema.Array(ServerTraceDiagnosticsSpanSummary),
  slowestSpans: Schema.Array(ServerTraceDiagnosticsSpanOccurrence),
  commonFailures: Schema.Array(ServerTraceDiagnosticsFailureSummary),
  latestFailures: Schema.Array(ServerTraceDiagnosticsRecentFailure),
  latestWarningAndErrorLogs: Schema.Array(ServerTraceDiagnosticsLogEvent),
  partialFailure: Schema.Option(Schema.Boolean),
  error: Schema.Option(
    Schema.Struct({
      kind: ServerTraceDiagnosticsErrorKind,
      message: TrimmedNonEmptyString,
    }),
  ),
});
export type ServerTraceDiagnosticsResult = typeof ServerTraceDiagnosticsResult.Type;

export const ServerProcessSignal = Schema.Literals(["SIGINT", "SIGKILL"]);
export type ServerProcessSignal = typeof ServerProcessSignal.Type;

export const ServerProcessAttributionScope = Schema.Literals(["core", "external"]);
export type ServerProcessAttributionScope = typeof ServerProcessAttributionScope.Type;

export const ServerProcessAttributionKind = Schema.Literals([
  "server",
  "ui",
  "provider",
  "terminal",
  "helper",
  "unknown",
]);
export type ServerProcessAttributionKind = typeof ServerProcessAttributionKind.Type;

export const ServerProcessAttributionConfidence = Schema.Literals([
  "exact",
  "inherited",
  "fallback",
]);
export type ServerProcessAttributionConfidence = typeof ServerProcessAttributionConfidence.Type;

export const ServerProcessResourceTotals = Schema.Struct({
  cpuPercent: Schema.Finite,
  rssBytes: NonNegativeInt,
  processCount: NonNegativeInt,
});
export type ServerProcessResourceTotals = typeof ServerProcessResourceTotals.Type;

export const ServerProcessAttributionTotals = Schema.Struct({
  combined: ServerProcessResourceTotals,
  core: ServerProcessResourceTotals,
  external: ServerProcessResourceTotals,
});
export type ServerProcessAttributionTotals = typeof ServerProcessAttributionTotals.Type;

export const ServerProcessUiCoverage = Schema.Struct({
  status: Schema.Literals(["available", "partial", "unavailable", "notApplicable"]),
  message: Schema.Option(TrimmedNonEmptyString),
});
export type ServerProcessUiCoverage = typeof ServerProcessUiCoverage.Type;

const ServerProcessCpuSplitMetric = Schema.Struct({
  combined: Schema.Finite,
  core: Schema.Finite,
  external: Schema.Finite,
});

const ServerProcessCountSplitMetric = Schema.Struct({
  combined: NonNegativeInt,
  core: NonNegativeInt,
  external: NonNegativeInt,
});

export const ServerProcessDiagnosticsEntry = Schema.Struct({
  pid: PositiveInt,
  ppid: NonNegativeInt,
  pgid: Schema.Option(Schema.Int),
  status: TrimmedNonEmptyString,
  cpuPercent: Schema.Finite,
  /**
   * The process's memory, despite the name: its physical footprint on a macOS server, as
   * Activity Monitor shows, and its resident size on Linux and Windows. Totals and
   * history sum this figure.
   */
  rssBytes: NonNegativeInt,
  elapsed: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  depth: NonNegativeInt,
  childPids: Schema.Array(PositiveInt),
  processKey: TrimmedNonEmptyString,
  scope: ServerProcessAttributionScope,
  kind: ServerProcessAttributionKind,
  label: TrimmedNonEmptyString,
  confidence: ServerProcessAttributionConfidence,
});
export type ServerProcessDiagnosticsEntry = typeof ServerProcessDiagnosticsEntry.Type;

export const ServerProcessDiagnosticsResult = Schema.Struct({
  serverPid: PositiveInt,
  readAt: Schema.DateTimeUtc,
  totals: ServerProcessAttributionTotals,
  uiCoverage: ServerProcessUiCoverage,
  processes: Schema.Array(ServerProcessDiagnosticsEntry),
  error: Schema.Option(
    Schema.Struct({
      message: TrimmedNonEmptyString,
    }),
  ),
});
export type ServerProcessDiagnosticsResult = typeof ServerProcessDiagnosticsResult.Type;

export const ServerProcessResourceHistoryInput = Schema.Struct({
  windowMs: NonNegativeInt,
  bucketMs: NonNegativeInt,
});
export type ServerProcessResourceHistoryInput = typeof ServerProcessResourceHistoryInput.Type;

export const ServerProcessResourceHistoryBucket = Schema.Struct({
  startedAt: Schema.DateTimeUtc,
  endedAt: Schema.DateTimeUtc,
  cpuPercent: Schema.Struct({
    average: ServerProcessCpuSplitMetric,
    peak: ServerProcessCpuSplitMetric,
  }),
  rssBytes: Schema.Struct({
    average: ServerProcessCountSplitMetric,
    peak: ServerProcessCountSplitMetric,
  }),
  maxProcessCount: ServerProcessCountSplitMetric,
});
export type ServerProcessResourceHistoryBucket = typeof ServerProcessResourceHistoryBucket.Type;

export const ServerProcessResourceHistorySummary = Schema.Struct({
  processKey: TrimmedNonEmptyString,
  pid: PositiveInt,
  ppid: NonNegativeInt,
  command: TrimmedNonEmptyString,
  depth: NonNegativeInt,
  scope: ServerProcessAttributionScope,
  kind: ServerProcessAttributionKind,
  label: TrimmedNonEmptyString,
  confidence: ServerProcessAttributionConfidence,
  firstSeenAt: Schema.DateTimeUtc,
  lastSeenAt: Schema.DateTimeUtc,
  currentCpuPercent: Schema.Finite,
  avgCpuPercent: Schema.Finite,
  maxCpuPercent: Schema.Finite,
  cpuSecondsApprox: Schema.Finite,
  currentRssBytes: NonNegativeInt,
  maxRssBytes: NonNegativeInt,
  sampleCount: NonNegativeInt,
});
export type ServerProcessResourceHistorySummary = typeof ServerProcessResourceHistorySummary.Type;

export const ServerProcessResourceHistoryFailureTag = Schema.Literals([
  "ProcessDiagnosticsQueryTimeoutError",
  "ProcessDiagnosticsQueryFailedError",
  "ProcessDiagnosticsServerProcessSignalError",
  "ProcessDiagnosticsNotDescendantError",
  "ProcessDiagnosticsSignalFailedError",
]);
export type ServerProcessResourceHistoryFailureTag =
  typeof ServerProcessResourceHistoryFailureTag.Type;

export const ServerProcessResourceHistoryResult = Schema.Struct({
  readAt: Schema.DateTimeUtc,
  windowMs: NonNegativeInt,
  bucketMs: NonNegativeInt,
  sampleIntervalMs: NonNegativeInt,
  retainedSampleCount: NonNegativeInt,
  cpuSecondsApprox: ServerProcessCpuSplitMetric,
  uiCoverage: ServerProcessUiCoverage,
  buckets: Schema.Array(ServerProcessResourceHistoryBucket),
  processes: Schema.Array(ServerProcessResourceHistorySummary),
  error: Schema.Option(
    Schema.Struct({
      failureTag: ServerProcessResourceHistoryFailureTag,
      message: TrimmedNonEmptyString,
    }),
  ),
});
export type ServerProcessResourceHistoryResult = typeof ServerProcessResourceHistoryResult.Type;

/** Facts about the host a server runs on (#292). */
export const ServerHostFacts = Schema.Struct({
  os: Schema.String,
  arch: Schema.String,
  cpuCount: NonNegativeInt,
  memoryTotalBytes: NonNegativeInt,
});
export type ServerHostFacts = typeof ServerHostFacts.Type;

const ServerHostMetricsVolumeState = Schema.Literals(["ok", "notResponding"]);
const isServerHostMetricsVolumeState = Schema.is(ServerHostMetricsVolumeState);

/** A volume's total and free bytes are relative to the user the server runs as. */
export const ServerHostMetricsVolume = Schema.Struct({
  mountPoint: Schema.String,
  name: Schema.String,
  fileSystem: Schema.String,
  totalBytes: Schema.NullOr(NonNegativeInt),
  freeBytes: Schema.NullOr(NonNegativeInt),
  usedBytes: Schema.NullOr(NonNegativeInt),
  removable: Schema.Boolean,
  readOnly: Schema.Boolean,
  /** A newer server's state decodes as `ok`: the values shown are the ones it sent. */
  state: Schema.String.pipe(
    Schema.decodeTo(
      ServerHostMetricsVolumeState,
      SchemaTransformation.transformEffect({
        decode: (value) =>
          Effect.succeed(isServerHostMetricsVolumeState(value) ? value : ("ok" as const)),
        encode: (value) => Effect.succeed(value),
      }),
    ),
  ),
});
export type ServerHostMetricsVolume = typeof ServerHostMetricsVolume.Type;

export const ServerHostMetricsSample = Schema.Struct({
  sampledAt: IsoDateTime,
  cpuPercent: Schema.Finite,
  memoryTotalBytes: NonNegativeInt,
  memoryUsedBytes: NonNegativeInt,
  memoryAvailableBytes: NonNegativeInt,
  volumes: Schema.Array(ServerHostMetricsVolume),
  volumesPaused: Schema.Boolean,
  /** The volume listing has run past the limit without answering, apart from any volume. */
  volumeListingNotResponding: Schema.optionalKey(Schema.Boolean),
  /** Rises by one per CPU and memory reading within one server run, whatever the wall clock does. */
  sequence: Schema.optionalKey(NonNegativeInt),
  /** The reading's time on the server's chart clock, which never runs backwards; `recent` points use it. */
  chartAt: Schema.optionalKey(IsoDateTime),
  /** How old the reading was, on the server's monotonic clock, when the item was encoded. */
  ageMs: Schema.optionalKey(NonNegativeInt),
});
export type ServerHostMetricsSample = typeof ServerHostMetricsSample.Type;

/** Since the server started: CPU percent or memory used percent. */
export const ServerHostMetricsStatistic = Schema.Struct({
  current: Schema.Finite,
  minimum: Schema.Finite,
  average: Schema.Finite,
  p95: Schema.Finite,
  maximum: Schema.Finite,
});
export type ServerHostMetricsStatistic = typeof ServerHostMetricsStatistic.Type;

/** A volume's used percent since the server started (R83), by mount point. */
export const ServerHostMetricsVolumeStatistic = Schema.Struct({
  mountPoint: Schema.String,
  statistic: ServerHostMetricsStatistic,
});
export type ServerHostMetricsVolumeStatistic = typeof ServerHostMetricsVolumeStatistic.Type;

const VolumeStatistics = Schema.Array(ServerHostMetricsVolumeStatistic).pipe(
  Schema.withDecodingDefault(Effect.succeed([])),
);

export const ServerHostMetricsChartPoint = Schema.Struct({
  sampledAt: IsoDateTime,
  cpuPercent: Schema.Finite,
  memoryPercent: Schema.Finite,
});
export type ServerHostMetricsChartPoint = typeof ServerHostMetricsChartPoint.Type;

export const ServerHostMetricsChartBucket = Schema.Struct({
  startedAt: IsoDateTime,
  durationMs: NonNegativeInt,
  cpuAverage: Schema.Finite,
  cpuPeak: Schema.Finite,
  memoryAverage: Schema.Finite,
  memoryPeak: Schema.Finite,
});
export type ServerHostMetricsChartBucket = typeof ServerHostMetricsChartBucket.Type;

/**
 * A volume the filter hid (R81). `reason` is `network`, `overlay`, `fileMount`, `empty` or
 * `sameStorage`; it is an open string so a reason a newer server adds cannot fail an older
 * client's whole snapshot. `sameStorageAs` names the shown volume a `sameStorage` one shares.
 */
export const ServerHostMetricsHiddenVolume = Schema.Struct({
  mountPoint: Schema.String,
  fileSystem: Schema.String,
  reason: Schema.String,
  sameStorageAs: Schema.optionalKey(Schema.String),
});
export type ServerHostMetricsHiddenVolume = typeof ServerHostMetricsHiddenVolume.Type;

/**
 * An item of `server.subscribeHostMetrics`: a `Snapshot` first, then one `Sample` per live
 * reading. A Sample carries `uptime` only when the subscriber has not been sent that chart yet.
 */
/** The host's state at once: the stream's first item, and `server.getHostMetrics` (R82). */
export const ServerHostMetricsSnapshot = Schema.TaggedStruct("Snapshot", {
  host: ServerHostFacts,
  bootId: Schema.NullOr(Schema.String),
  startedAt: IsoDateTime,
  statisticsSince: Schema.NullOr(IsoDateTime),
  sample: Schema.NullOr(ServerHostMetricsSample),
  cpu: Schema.NullOr(ServerHostMetricsStatistic),
  memory: Schema.NullOr(ServerHostMetricsStatistic),
  recent: Schema.Array(ServerHostMetricsChartPoint),
  uptime: Schema.Array(ServerHostMetricsChartBucket),
  hiddenVolumes: Schema.Array(ServerHostMetricsHiddenVolume).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Absent from older servers. */
  volumeStatistics: VolumeStatistics,
});
export type ServerHostMetricsSnapshot = typeof ServerHostMetricsSnapshot.Type;

export const ServerHostMetricsEvent = Schema.Union([
  ServerHostMetricsSnapshot,
  Schema.TaggedStruct("Sample", {
    /** The snapshot's `statisticsSince`, so a stream that began before the first reading learns it. */
    statisticsSince: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
    sample: ServerHostMetricsSample,
    cpu: ServerHostMetricsStatistic,
    memory: ServerHostMetricsStatistic,
    uptime: Schema.NullOr(Schema.Array(ServerHostMetricsChartBucket)),
    /** Sent with `uptime`, as part of the same chart state; absent means unchanged. */
    hiddenVolumes: Schema.optionalKey(Schema.Array(ServerHostMetricsHiddenVolume)),
    /** Every Sample carries them; absent from older servers. */
    volumeStatistics: VolumeStatistics,
  }),
]);
export type ServerHostMetricsEvent = typeof ServerHostMetricsEvent.Type;

export const ServerSignalProcessInput = Schema.Struct({
  pid: PositiveInt,
  processKey: TrimmedNonEmptyString,
  signal: ServerProcessSignal,
});
export type ServerSignalProcessInput = typeof ServerSignalProcessInput.Type;

export const ServerSignalProcessResult = Schema.Struct({
  pid: PositiveInt,
  signal: ServerProcessSignal,
  signaled: Schema.Boolean,
  message: Schema.Option(TrimmedNonEmptyString),
});
export type ServerSignalProcessResult = typeof ServerSignalProcessResult.Type;

/** The largest diagnostic archive a server sends or a client accepts (20 MiB). */
export const DIAGNOSTIC_LOGS_MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
/** The most archive bytes one `Data` item of `server.downloadDiagnosticLogs` carries. */
export const DIAGNOSTIC_LOGS_CHUNK_BYTES = 64 * 1024;

export const DiagnosticLogsDownloadInput = Schema.Struct({
  /** This client's frontend warning/error snapshot, bounded like the HTTP request body. */
  frontendLog: Schema.String,
  /** Crash dumps hold raw memory; they need `orchestration:operate`. Absent means false. */
  includeCrashDumps: Schema.optional(Schema.Boolean),
});
export type DiagnosticLogsDownloadInput = typeof DiagnosticLogsDownloadInput.Type;

/** The archive's `manifest.json`: which server built it, and what it holds. */
export const DiagnosticLogsManifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  /** The server's self-declared id, `local` on most servers. */
  environmentId: TrimmedNonEmptyString,
  /** The persistent store's id, which a client keys a remote environment by. */
  storageInstanceId: Schema.NullOr(TrimmedNonEmptyString),
  environmentLabel: TrimmedNonEmptyString,
  serverVersion: TrimmedNonEmptyString,
  platform: Schema.Struct({ os: Schema.String, arch: Schema.String }),
  generatedAt: Schema.String,
  /** `included` counts the dumps written, which can be fewer than were asked for. */
  crashDumps: Schema.Struct({ requested: Schema.Boolean, included: NonNegativeInt }),
});
export type DiagnosticLogsManifest = typeof DiagnosticLogsManifest.Type;

/**
 * `server.downloadDiagnosticLogs`: one `Started` first, then `Data` items (base64, at most
 * {@link DIAGNOSTIC_LOGS_CHUNK_BYTES} each) whose decoded lengths sum to `byteLength`, then the
 * stream completes.
 */
export const DiagnosticLogsDownloadEvent = Schema.Union([
  Schema.TaggedStruct("Started", {
    fileName: TrimmedNonEmptyString,
    byteLength: NonNegativeInt,
    manifest: DiagnosticLogsManifest,
  }),
  Schema.TaggedStruct("Data", { data: Schema.String }),
]);
export type DiagnosticLogsDownloadEvent = typeof DiagnosticLogsDownloadEvent.Type;

export class DiagnosticLogsError extends Schema.TaggedError<DiagnosticLogsError>()(
  "DiagnosticLogsError",
  {
    reason: Schema.Literals(["invalid", "build-failed", "too-large"]),
    message: TrimmedNonEmptyString,
  },
) {}

/**
 * A `bibcode diagnostics download` on this host waiting for the desktop app (#201): the
 * environment it names as typed (an id or a label, resolved by the app), whether it asked
 * for crash dumps, the code the command printed (so the user can tell their own command
 * from another program's), and the directory it will save in. `requestId` is new for every
 * request, so an item for an older one is stale.
 */
export const DiagnosticLogsRelayRequest = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  environment: TrimmedNonEmptyString,
  includeCrashDumps: Schema.Boolean,
  code: TrimmedNonEmptyString,
  outputDirectory: TrimmedNonEmptyString,
});
export type DiagnosticLogsRelayRequest = typeof DiagnosticLogsRelayRequest.Type;

/**
 * `server.subscribeDiagnosticLogsRelay`: a request to approve; `Claimed` once a window took
 * it, so the others drop their prompt; then `Closed` once it is over (answered, expired, or
 * the command left), which also stops the claiming window's download.
 */
export const DiagnosticLogsRelayEvent = Schema.Union([
  Schema.TaggedStruct("Pending", { request: DiagnosticLogsRelayRequest }),
  Schema.TaggedStruct("Claimed", { requestId: TrimmedNonEmptyString }),
  Schema.TaggedStruct("Closed", { requestId: TrimmedNonEmptyString }),
]);
export type DiagnosticLogsRelayEvent = typeof DiagnosticLogsRelayEvent.Type;

export const DiagnosticLogsRelayClaimInput = Schema.Struct({ requestId: TrimmedNonEmptyString });
export type DiagnosticLogsRelayClaimInput = typeof DiagnosticLogsRelayClaimInput.Type;

/** `claimed` is false when another window answered first or the request is already over. */
export const DiagnosticLogsRelayClaimResult = Schema.Struct({ claimed: Schema.Boolean });
export type DiagnosticLogsRelayClaimResult = typeof DiagnosticLogsRelayClaimResult.Type;

/** Why the app could not relay the logs; the command prints `message`. */
export const DiagnosticLogsRelayFailureReason = Schema.Literals([
  "unknown-environment",
  "ambiguous-environment",
  "not-connected",
  "unsupported",
  "unverified",
  "wrong-environment",
  "incomplete",
  "too-large",
  "not-permitted",
  "crash-dumps-refused",
  "server-failed",
  "connection-lost",
]);
export type DiagnosticLogsRelayFailureReason = typeof DiagnosticLogsRelayFailureReason.Type;

/**
 * What the claiming app sends for a request, in order: `Denied` or `Failed` alone, or
 * `Started`, `Data` items (base64, at most {@link DIAGNOSTIC_LOGS_CHUNK_BYTES} each) whose
 * decoded lengths sum to `byteLength`, then `Finished`.
 */
export const DiagnosticLogsRelayItem = Schema.Union([
  Schema.TaggedStruct("Denied", {}),
  Schema.TaggedStruct("Failed", {
    reason: DiagnosticLogsRelayFailureReason,
    message: TrimmedNonEmptyString,
  }),
  Schema.TaggedStruct("Started", {
    fileName: TrimmedNonEmptyString,
    byteLength: NonNegativeInt,
    manifest: DiagnosticLogsManifest,
  }),
  Schema.TaggedStruct("Data", { data: Schema.String }),
  Schema.TaggedStruct("Finished", {}),
]);
export type DiagnosticLogsRelayItem = typeof DiagnosticLogsRelayItem.Type;

export const DiagnosticLogsRelaySendInput = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  item: DiagnosticLogsRelayItem,
});
export type DiagnosticLogsRelaySendInput = typeof DiagnosticLogsRelaySendInput.Type;

/**
 * Why the server refused an item. `stale`: the request is over or was never this
 * connection's (stop sending); `cancelled`: the command left (stop the download);
 * `invalid`: the item broke the order or a bound, which ends the request.
 */
export class DiagnosticLogsRelayError extends Schema.TaggedError<DiagnosticLogsRelayError>()(
  "DiagnosticLogsRelayError",
  {
    reason: Schema.Literals(["stale", "cancelled", "invalid", "not-desktop"]),
    message: TrimmedNonEmptyString,
  },
) {}

/**
 * The command an AI agent on the server's host runs to reach it over MCP (#139): the server's
 * own executable, `mcp`, its data root and, for the `dev` state, its dev URL. Clients wrap it
 * for WSL or SSH and quote it for the shell; they never guess any part of it.
 */
export const ServerMcpLaunch = Schema.Struct({
  argv: Schema.Array(Schema.String),
});
export type ServerMcpLaunch = typeof ServerMcpLaunch.Type;

export const ServerConfig = Schema.Struct({
  environment: ExecutionEnvironmentDescriptor,
  auth: ServerAuthDescriptor,
  cwd: TrimmedNonEmptyString,
  keybindingsConfigPath: TrimmedNonEmptyString,
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
  providers: ServerProviders,
  /**
   * Absent from a server older than tool maintenance. A snapshot that carries the key, even
   * empty, is how a client learns the server supports `server.updateTool`.
   */
  tools: Schema.optionalKey(ServerTools),
  availableEditors: Schema.Array(EditorId),
  observability: ServerObservability,
  settings: ServerSettings,
  /** Absent from a server older than MCP support; `null` when it cannot name its executable. */
  mcpLaunch: Schema.optionalKey(Schema.NullOr(ServerMcpLaunch)),
});
export type ServerConfig = typeof ServerConfig.Type;

const ServerUpsertKeybindingReplaceTarget = Schema.Struct({
  key: KeybindingValue,
  command: KeybindingCommand,
  when: Schema.optional(KeybindingWhen),
});

export const ServerUpsertKeybindingInput = Schema.Struct({
  key: KeybindingValue,
  command: KeybindingCommand,
  when: Schema.optional(KeybindingWhen),
  replace: Schema.optional(ServerUpsertKeybindingReplaceTarget),
});
export type ServerUpsertKeybindingInput = typeof ServerUpsertKeybindingInput.Type;

export const ServerRemoveKeybindingInput = ServerUpsertKeybindingReplaceTarget;
export type ServerRemoveKeybindingInput = typeof ServerRemoveKeybindingInput.Type;

export const ServerUpsertKeybindingResult = Schema.Struct({
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
});
export type ServerUpsertKeybindingResult = typeof ServerUpsertKeybindingResult.Type;

export const ServerRemoveKeybindingResult = ServerUpsertKeybindingResult;
export type ServerRemoveKeybindingResult = typeof ServerRemoveKeybindingResult.Type;

export const ServerConfigUpdatedPayload = Schema.Struct({
  issues: ServerConfigIssues,
  providers: ServerProviders,
  settings: Schema.optional(ServerSettings),
});
export type ServerConfigUpdatedPayload = typeof ServerConfigUpdatedPayload.Type;

export const ServerConfigKeybindingsUpdatedPayload = Schema.Struct({
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
});
export type ServerConfigKeybindingsUpdatedPayload =
  typeof ServerConfigKeybindingsUpdatedPayload.Type;

export const ServerConfigProviderStatusesPayload = Schema.Struct({
  providers: ServerProviders,
  /** Absent means unchanged, not empty: only a tool change carries it. */
  tools: Schema.optionalKey(ServerTools),
});
export type ServerConfigProviderStatusesPayload = typeof ServerConfigProviderStatusesPayload.Type;

export const ServerConfigSettingsUpdatedPayload = Schema.Struct({
  settings: ServerSettings,
});
export type ServerConfigSettingsUpdatedPayload = typeof ServerConfigSettingsUpdatedPayload.Type;

export const ServerConfigStreamSnapshotEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("snapshot"),
  config: ServerConfig,
});
export type ServerConfigStreamSnapshotEvent = typeof ServerConfigStreamSnapshotEvent.Type;

export const ServerConfigStreamKeybindingsUpdatedEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("keybindingsUpdated"),
  payload: ServerConfigKeybindingsUpdatedPayload,
});
export type ServerConfigStreamKeybindingsUpdatedEvent =
  typeof ServerConfigStreamKeybindingsUpdatedEvent.Type;

export const ServerConfigStreamProviderStatusesEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("providerStatuses"),
  payload: ServerConfigProviderStatusesPayload,
});
export type ServerConfigStreamProviderStatusesEvent =
  typeof ServerConfigStreamProviderStatusesEvent.Type;

export const ServerConfigStreamSettingsUpdatedEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("settingsUpdated"),
  payload: ServerConfigSettingsUpdatedPayload,
});
export type ServerConfigStreamSettingsUpdatedEvent =
  typeof ServerConfigStreamSettingsUpdatedEvent.Type;

export const ServerConfigStreamEvent = Schema.Union([
  ServerConfigStreamSnapshotEvent,
  ServerConfigStreamKeybindingsUpdatedEvent,
  ServerConfigStreamProviderStatusesEvent,
  ServerConfigStreamSettingsUpdatedEvent,
]);
export type ServerConfigStreamEvent = typeof ServerConfigStreamEvent.Type;

export const ServerLifecycleReadyPayload = Schema.Struct({
  at: IsoDateTime,
  environment: ExecutionEnvironmentDescriptor,
});
export type ServerLifecycleReadyPayload = typeof ServerLifecycleReadyPayload.Type;

export const ServerLifecycleWelcomePayload = Schema.Struct({
  environment: ExecutionEnvironmentDescriptor,
  cwd: TrimmedNonEmptyString,
  projectName: TrimmedNonEmptyString,
  bootstrapProjectId: Schema.optional(ProjectId),
  bootstrapThreadId: Schema.optional(ThreadId),
});
export type ServerLifecycleWelcomePayload = typeof ServerLifecycleWelcomePayload.Type;

export const ServerLifecycleStreamWelcomeEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("welcome"),
  payload: ServerLifecycleWelcomePayload,
});
export type ServerLifecycleStreamWelcomeEvent = typeof ServerLifecycleStreamWelcomeEvent.Type;

export const ServerLifecycleStreamReadyEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("ready"),
  payload: ServerLifecycleReadyPayload,
});
export type ServerLifecycleStreamReadyEvent = typeof ServerLifecycleStreamReadyEvent.Type;

export const ServerLifecycleStreamEvent = Schema.Union([
  ServerLifecycleStreamWelcomeEvent,
  ServerLifecycleStreamReadyEvent,
]);
export type ServerLifecycleStreamEvent = typeof ServerLifecycleStreamEvent.Type;

export const ServerProviderUpdatedPayload = Schema.Struct({
  providers: ServerProviders,
});
export type ServerProviderUpdatedPayload = typeof ServerProviderUpdatedPayload.Type;

export const ServerProviderUpdateInput = Schema.Struct({
  provider: ProviderDriverKind,
  instanceId: Schema.optionalKey(ProviderInstanceId),
});
export type ServerProviderUpdateInput = typeof ServerProviderUpdateInput.Type;

export const ServerToolUpdatedPayload = Schema.Struct({
  tools: ServerTools,
});
export type ServerToolUpdatedPayload = typeof ServerToolUpdatedPayload.Type;

export const ServerToolUpdateInput = Schema.Struct({
  toolId: TrimmedNonEmptyString,
});
export type ServerToolUpdateInput = typeof ServerToolUpdateInput.Type;

export class ServerToolUpdateError extends Schema.TaggedError<ServerToolUpdateError>()(
  "ServerToolUpdateError",
  {
    toolId: TrimmedNonEmptyString,
    reason: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Tool update failed for ${this.toolId}: ${this.reason}`;
  }
}

export class ServerProviderUpdateError extends Schema.TaggedError<ServerProviderUpdateError>()(
  "ServerProviderUpdateError",
  {
    provider: ProviderDriverKind,
    reason: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider update failed for ${this.provider}: ${this.reason}`;
  }
}
