// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { ProviderDriverKind } from "./providerInstance.ts";
import {
  DiagnosticLogsDownloadEvent,
  DiagnosticLogsRelayEvent,
  DiagnosticLogsRelayItem,
  isProviderAvailable,
  ServerConfig,
  ServerConfigProviderStatusesPayload,
  ServerHostMetricsEvent,
  ServerProcessDiagnosticsEntry,
  ServerProcessResourceTotals,
  ServerProvider,
  ServerProviderUpdateError,
  ServerProviderUpdateInput,
  ServerTool,
  ServerToolUpdateError,
  ServerToolUpdateInput,
  ServerTraceDiagnosticsRecentFailure,
  ServerTraceDiagnosticsSpanOccurrence,
  ServerTraceDiagnosticsSpanSummary,
} from "./server.ts";
import {
  expectDecodeFailure,
  expectEncodeFailure,
  makeInvalidClassInstance,
} from "./test/schemaAssertions.ts";

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);
const decodeProviderDriverKind = Schema.decodeUnknownSync(ProviderDriverKind);
const decodeProviderUpdateError = Schema.decodeUnknownSync(ServerProviderUpdateError);
const decodeProcessDiagnosticsEntry = Schema.decodeUnknownSync(ServerProcessDiagnosticsEntry);
const decodeProcessResourceTotals = Schema.decodeUnknownSync(ServerProcessResourceTotals);
const encodeProviderUpdateError = Schema.encodeSync(ServerProviderUpdateError);
const decodeTraceOccurrence = Schema.decodeUnknownSync(
  Schema.toCodecJson(ServerTraceDiagnosticsSpanOccurrence),
);
const decodeTraceFailure = Schema.decodeUnknownSync(
  Schema.toCodecJson(ServerTraceDiagnosticsRecentFailure),
);
const decodeTraceSummary = Schema.decodeUnknownSync(ServerTraceDiagnosticsSpanSummary);
const decodeEvent = Schema.decodeUnknownSync(DiagnosticLogsDownloadEvent);

// What a client or server from before tool maintenance understands.
const { tools: _legacyPayloadTools, ...legacyPayloadFields } =
  ServerConfigProviderStatusesPayload.fields;
const LegacyProviderStatusesPayload = Schema.Struct(legacyPayloadFields);
const ConfigFields = Schema.Struct({
  providers: ServerConfig.fields.providers,
  tools: ServerConfig.fields.tools,
});
const LegacyConfigFields = Schema.Struct({ providers: ServerConfig.fields.providers });
const decodeTool = Schema.decodeUnknownSync(ServerTool);
const encodeToolUpdateError = Schema.encodeSync(ServerToolUpdateError);
const decodeToolUpdateError = Schema.decodeUnknownSync(ServerToolUpdateError);
const decodeConfigFields = Schema.decodeUnknownSync(ConfigFields);
const decodeLegacyConfigFields = Schema.decodeUnknownSync(LegacyConfigFields);
const decodeStatusesPayload = Schema.decodeUnknownSync(ServerConfigProviderStatusesPayload);
const decodeLegacyStatusesPayload = Schema.decodeUnknownSync(LegacyProviderStatusesPayload);

const baseProviderSnapshot = {
  instanceId: "codex",
  driver: "codex",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: {
    status: "authenticated",
  },
  checkedAt: "2026-04-10T00:00:00.000Z",
  models: [],
};

describe("trace timing compatibility", () => {
  it("preserves measured/unavailable metadata while accepting older numeric timing", () => {
    const occurrence = {
      name: "gitManager.getRefs",
      durationMs: 0,
      endedAt: "2026-10-02T00:00:00.000Z",
      traceId: "trace",
      spanId: "span",
    };
    for (const decode of [decodeTraceOccurrence, decodeTraceFailure]) {
      const input = { ...occurrence, cause: "launch was denied" };
      expect(decode(input).durationMeasured).toBeUndefined();
      for (const durationMeasured of [false, true]) {
        expect(decode({ ...input, durationMeasured }).durationMeasured).toBe(durationMeasured);
      }
      expect(() => decode({ ...input, durationMeasured: "yes" })).toThrow();
      expect(() => decode({ ...input, durationMs: null })).toThrow();
    }
    const summary = {
      name: "gitManager.getRefs",
      count: 3,
      failureCount: 3,
      totalDurationMs: 10,
      averageDurationMs: 10,
      maxDurationMs: 10,
    };
    expect(decodeTraceSummary(summary).measuredCount).toBeUndefined();
    expect(decodeTraceSummary({ ...summary, measuredCount: 1 }).measuredCount).toBe(1);
    expect(() => decodeTraceSummary({ ...summary, measuredCount: -1 })).toThrow();
  });
});

describe("ServerProvider", () => {
  it("keeps older snapshots compatible with the optional turn-steer capability", () => {
    expect(decodeServerProvider(baseProviderSnapshot).supportsTurnSteer).toBeUndefined();
    for (const supportsTurnSteer of [true, false]) {
      expect(
        decodeServerProvider({ ...baseProviderSnapshot, supportsTurnSteer }).supportsTurnSteer,
      ).toBe(supportsTurnSteer);
    }
    expect(() =>
      decodeServerProvider({ ...baseProviderSnapshot, supportsTurnSteer: "true" }),
    ).toThrow();
  });

  it("keeps older snapshots compatible with the optional conversation-rewind capability", () => {
    expect(decodeServerProvider(baseProviderSnapshot).supportsConversationRewind).toBeUndefined();
    expect(
      decodeServerProvider({ ...baseProviderSnapshot, supportsConversationRewind: true })
        .supportsConversationRewind,
    ).toBe(true);
    expect(() =>
      decodeServerProvider({ ...baseProviderSnapshot, supportsConversationRewind: "true" }),
    ).toThrow();
  });

  it("keeps older snapshots compatible with the optional compaction capability", () => {
    expect(decodeServerProvider(baseProviderSnapshot).supportsCompaction).toBeUndefined();
    expect(
      decodeServerProvider({ ...baseProviderSnapshot, supportsCompaction: true })
        .supportsCompaction,
    ).toBe(true);
    expect(() =>
      decodeServerProvider({ ...baseProviderSnapshot, supportsCompaction: "true" }),
    ).toThrow();
  });

  it("defaults capability arrays when decoding provider snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.slashCommands).toEqual([]);
    expect(parsed.skills).toEqual([]);
    expect(parsed.agents).toEqual([]);
    expect(parsed.versionAdvisory).toBeUndefined();
    expect(parsed.updateState).toBeUndefined();
  });

  it("keeps old snapshots compatible and decodes context-usage capability", () => {
    expect(decodeServerProvider(baseProviderSnapshot).supportsMcpStatus).toBeUndefined();
    expect(
      decodeServerProvider({ ...baseProviderSnapshot, supportsMcpStatus: true }).supportsMcpStatus,
    ).toBe(true);
    expect(decodeServerProvider(baseProviderSnapshot).supportsContextWindowUsage).toBeUndefined();
    expect(
      decodeServerProvider({
        ...baseProviderSnapshot,
        supportsContextWindowUsage: true,
      }).supportsContextWindowUsage,
    ).toBe(true);
    expect(
      decodeServerProvider({
        ...baseProviderSnapshot,
        supportsContextWindowUsage: false,
      }).supportsContextWindowUsage,
    ).toBe(false);
  });

  it("defaults one-click update support when decoding older advisory snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
      versionAdvisory: {
        status: "behind_latest",
        currentVersion: "1.0.0",
        latestVersion: "1.0.1",
        updateCommand: "npm install -g @openai/codex@latest",
        checkedAt: "2026-04-10T00:00:00.000Z",
        message: "Update available.",
      },
    });

    expect(parsed.versionAdvisory?.canUpdate).toBe(false);
  });

  it("decodes continuation group metadata", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex_personal",
      driver: "codex",
      continuation: { groupKey: "codex:home:/Users/julius/.codex" },
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.continuation?.groupKey).toBe("codex:home:/Users/julius/.codex");
  });

  it("treats omitted availability as available and explicit unavailability as unavailable", () => {
    const base = {
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    } as const;

    expect(isProviderAvailable(decodeServerProvider(base))).toBe(true);
    expect(
      isProviderAvailable(
        decodeServerProvider({
          ...base,
          availability: "unavailable",
          unavailableReason: "offline",
        }),
      ),
    ).toBe(false);
  });

  it("decodes optional provider-agent invocation metadata", () => {
    const parsed = decodeServerProvider({
      ...baseProviderSnapshot,
      agents: [{ name: "legacy-agent" }, { name: "reviewer", invocation: "mention" }],
    });

    expect(parsed.agents).toEqual([
      { name: "legacy-agent" },
      { name: "reviewer", invocation: "mention" },
    ]);
  });

  it("rejects unknown provider-agent invocation metadata", () => {
    expect(() =>
      decodeServerProvider({
        ...baseProviderSnapshot,
        agents: [{ name: "reviewer", invocation: "slash" }],
      }),
    ).toThrow();
  });
});

describe("ServerProviderUpdateError", () => {
  const provider = decodeProviderDriverKind("codex");
  const error = new ServerProviderUpdateError({
    provider,
    reason: "update process failed",
    cause: "exit 1",
  });

  it("constructs a tagged error with provider context and round-trips it", () => {
    expect(error.message).toBe("Provider update failed for codex: update process failed");
    const encoded = encodeProviderUpdateError(error);
    expect(decodeProviderUpdateError(encoded)._tag).toBe("ServerProviderUpdateError");
  });

  it("reports invalid provider paths on decode and encode", () => {
    const invalid = {
      _tag: "ServerProviderUpdateError",
      provider: "Invalid Provider",
      reason: "update failed",
    };
    const expectedPath = {
      paths: [["provider"]],
      containsTag: "InvalidValue" as const,
    };
    const decodeExpected = {
      ...expectedPath,
      rootTag: "Encoding" as const,
    };
    const encodeExpected = { ...expectedPath, rootTag: "Composite" as const };
    expectDecodeFailure(ServerProviderUpdateError, invalid, decodeExpected);
    expectEncodeFailure(
      ServerProviderUpdateError,
      makeInvalidClassInstance(ServerProviderUpdateError.prototype, invalid),
      encodeExpected,
    );
  });

  it("reports invalid update input providers on decode and encode", () => {
    const invalid = { provider: "Invalid Provider" };
    const expected = {
      rootTag: "Composite" as const,
      paths: [["provider"]],
      containsTag: "InvalidValue" as const,
    };
    expectDecodeFailure(ServerProviderUpdateInput, invalid, expected);
    expectEncodeFailure(ServerProviderUpdateInput, invalid, expected);
  });
});

describe("server process resource metrics", () => {
  const totals = {
    cpuPercent: 1,
    rssBytes: 1024,
    processCount: 1,
  };
  const process = {
    pid: 1,
    ppid: 0,
    pgid: Option.none(),
    status: "Run",
    cpuPercent: 1,
    rssBytes: 1024,
    elapsed: "00:00:01",
    command: "bibcode",
    depth: 0,
    childPids: [],
    processKey: "1:1",
    scope: "core",
    kind: "server",
    label: "BiBCode Server",
    confidence: "exact",
  };

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects non-finite live CPU values at the contract boundary",
    (cpuPercent) => {
      const expected = {
        rootTag: "Composite" as const,
        paths: [["cpuPercent"]],
        containsTag: "Filter" as const,
      };

      expectDecodeFailure(ServerProcessResourceTotals, { ...totals, cpuPercent }, expected);
      expectDecodeFailure(ServerProcessDiagnosticsEntry, { ...process, cpuPercent }, expected);
    },
  );

  it("preserves finite negative live CPU values", () => {
    expect(decodeProcessResourceTotals({ ...totals, cpuPercent: -1.5 }).cpuPercent).toBe(-1.5);
    expect(decodeProcessDiagnosticsEntry({ ...process, cpuPercent: -1.5 }).cpuPercent).toBe(-1.5);
  });
});

describe("DiagnosticLogsDownloadEvent", () => {
  const manifest = {
    schemaVersion: 1,
    environmentId: "local",
    storageInstanceId: "storage-1",
    environmentLabel: "ai-server",
    serverVersion: "0.12.0",
    platform: { os: "linux", arch: "x86_64" },
    generatedAt: "2026-10-27T12:00:00Z",
    crashDumps: { requested: false, included: 0 },
  };

  it("decodes the Started item the server sends and the Data items after it", () => {
    expect(
      decodeEvent({
        _tag: "Started",
        fileName: "bibcode-diagnostics-ai-server-20261027T120000Z.zip",
        byteLength: 2048,
        manifest,
      }),
    ).toMatchObject({ _tag: "Started", manifest: { storageInstanceId: "storage-1" } });
    expect(decodeEvent({ _tag: "Data", data: "UEsDBA==" })).toEqual({
      _tag: "Data",
      data: "UEsDBA==",
    });
  });

  it("rejects a manifest whose crash-dump count is not a count", () => {
    expect(() =>
      decodeEvent({
        _tag: "Started",
        fileName: "x.zip",
        byteLength: 1,
        manifest: { ...manifest, crashDumps: { requested: true, included: -1 } },
      }),
    ).toThrow();
  });
});

const decodeItem = Schema.decodeUnknownSync(DiagnosticLogsRelayItem);
const decodeRelayEvent = Schema.decodeUnknownSync(DiagnosticLogsRelayEvent);

describe("diagnostic logs relay (#201)", () => {
  it("carries a request to approve, then its close", () => {
    expect(
      decodeRelayEvent({
        _tag: "Pending",
        request: {
          requestId: "relay_1",
          environment: "Omarchy",
          includeCrashDumps: false,
          code: "K7Q-4M",
          outputDirectory: "/Users/me/logs",
        },
      }),
    ).toMatchObject({ _tag: "Pending", request: { environment: "Omarchy", code: "K7Q-4M" } });
    expect(decodeRelayEvent({ _tag: "Claimed", requestId: "relay_1" })._tag).toBe("Claimed");
    expect(decodeRelayEvent({ _tag: "Closed", requestId: "relay_1" })._tag).toBe("Closed");
  });

  it("names a failure by its reason, and refuses unknown reasons", () => {
    expect(
      decodeItem({
        _tag: "Failed",
        reason: "unknown-environment",
        message: "BiBCode has no environment named Mars.",
      }),
    ).toMatchObject({ _tag: "Failed", reason: "unknown-environment" });
    expect(() => decodeItem({ _tag: "Failed", reason: "made-up", message: "x" })).toThrow();
    expect(decodeItem({ _tag: "Finished" })._tag).toBe("Finished");
  });
});

describe("tool update contracts", () => {
  const readCompat = (name: string): Record<string, any> =>
    JSON.parse(
      NodeFS.readFileSync(
        new URL(`../fixtures/server-config-compat/${name}.json`, import.meta.url),
        "utf8",
      ),
    ) as Record<string, any>;
  const tool = {
    toolId: "codegraph",
    displayName: "CodeGraph",
    installed: true,
    version: "1.6.2",
    checkedAt: "2026-11-02T00:00:00.000Z",
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "1.6.2",
      latestVersion: "1.6.3",
      updateCommand: "codegraph upgrade",
      canUpdate: true,
      checkedAt: "2026-11-02T00:00:00.000Z",
      message: null,
    },
  };

  it("decodes a tool with its advisory and update state", () => {
    const decoded = decodeTool({
      ...tool,
      updateState: {
        status: "running",
        startedAt: "2026-11-02T00:00:01.000Z",
        finishedAt: null,
        message: "Updating tool.",
        output: null,
      },
    });
    expect(decoded.versionAdvisory?.canUpdate).toBe(true);
    expect(decoded.updateState?.status).toBe("running");
  });

  it("rejects an update input without a tool id", () => {
    expectDecodeFailure(
      ServerToolUpdateInput,
      { toolId: "" },
      { rootTag: "Composite", paths: [["toolId"]], containsTag: "InvalidValue" },
    );
  });

  it("round-trips the tagged update error", () => {
    const error = new ServerToolUpdateError({ toolId: "codegraph", reason: "still updating" });
    expect(error.message).toBe("Tool update failed for codegraph: still updating");
    const encoded = encodeToolUpdateError(error);
    expect(decodeToolUpdateError(encoded)._tag).toBe("ServerToolUpdateError");
  });

  it("old server, new client: a config and a status event without tools still decode", () => {
    expect(decodeConfigFields(readCompat("old-server-config-fields")).tools).toBe(undefined);
    const event = readCompat("old-server-provider-statuses");
    expect(decodeStatusesPayload(event.payload).tools).toBe(undefined);
  });

  it("new server, old client: the added tools key is ignored by the previous schema", () => {
    const config = readCompat("new-server-config-fields");
    expect(decodeConfigFields(config).tools).toHaveLength(1);
    expect(decodeLegacyConfigFields(config)).not.toHaveProperty("tools");
    const event = readCompat("new-server-provider-statuses");
    expect(decodeStatusesPayload(event.payload).tools).toHaveLength(1);
    expect(decodeLegacyStatusesPayload(event.payload)).not.toHaveProperty("tools");
  });
});

const decodeHostMetricsEvent = Schema.decodeUnknownSync(ServerHostMetricsEvent);
const encodeHostMetricsEvent = Schema.encodeSync(ServerHostMetricsEvent);

describe("ServerHostMetricsEvent", () => {
  const decode = decodeHostMetricsEvent;
  const encode = encodeHostMetricsEvent;
  const sample = {
    sampledAt: "2026-11-11T12:00:01.000Z",
    cpuPercent: 23.5,
    memoryTotalBytes: 34_359_738_368,
    memoryUsedBytes: 12_025_908_428,
    memoryAvailableBytes: 22_333_829_940,
    volumes: [
      {
        mountPoint: "/",
        name: "",
        fileSystem: "ext4",
        totalBytes: 2_147_483_648_000,
        freeBytes: 671_088_640_000,
        usedBytes: 1_476_395_008_000,
        removable: false,
        readOnly: false,
        state: "ok",
      },
      {
        mountPoint: "/mnt/slow",
        name: "",
        fileSystem: "ext4",
        totalBytes: null,
        freeBytes: null,
        usedBytes: null,
        removable: false,
        readOnly: false,
        state: "notResponding",
      },
    ],
    volumesPaused: false,
  };
  const statistic = { current: 23.5, minimum: 1.5, average: 11.25, p95: 40, maximum: 97.5 };
  const bucket = {
    startedAt: "2026-11-11T11:59:00.000Z",
    durationMs: 60_000,
    cpuAverage: 12.5,
    cpuPeak: 40.5,
    memoryAverage: 35.5,
    memoryPeak: 36.5,
  };
  const snapshot = {
    _tag: "Snapshot",
    host: { os: "linux", arch: "x86_64", cpuCount: 12, memoryTotalBytes: 34_359_738_368 },
    bootId: "00000000-0000-0000-0000-000000000000",
    startedAt: "2026-11-11T09:00:00.000Z",
    statisticsSince: "2026-11-11T09:00:00.000Z",
    sample,
    cpu: statistic,
    memory: statistic,
    recent: [{ sampledAt: sample.sampledAt, cpuPercent: 23.5, memoryPercent: 35.5 }],
    uptime: [bucket],
  };

  it("round-trips a snapshot and a sample", () => {
    expect(encode(decode(snapshot))).toEqual(snapshot);
    const live = { _tag: "Sample", sample, cpu: statistic, memory: statistic, uptime: null };
    expect(encode(decode(live))).toEqual(live);
    const withChart = { ...live, uptime: [bucket] };
    expect(encode(decode(withChart))).toEqual(withChart);
  });

  it("accepts a server without a boot ID or a first reading", () => {
    const empty = {
      ...snapshot,
      bootId: null,
      statisticsSince: null,
      sample: null,
      cpu: null,
      memory: null,
      recent: [],
      uptime: [],
    };
    expect(decode(empty)).toMatchObject({ _tag: "Snapshot", bootId: null, sample: null });
  });

  it("rejects an unknown item", () => {
    expect(() => decode({ ...snapshot, _tag: "Delta" })).toThrow();
  });

  it("round-trips the order, age, listing and statistics start fields, and accepts their absence", () => {
    const ordered = {
      ...sample,
      volumeListingNotResponding: true,
      sequence: 42,
      ageMs: 120,
    };
    const live = {
      _tag: "Sample",
      statisticsSince: "2026-11-11T09:00:00.000Z",
      sample: ordered,
      cpu: statistic,
      memory: statistic,
      uptime: null,
    };
    expect(encode(decode(live))).toEqual(live);
    expect(encode(decode({ ...live, statisticsSince: null }))).toEqual({
      ...live,
      statisticsSince: null,
    });
    expect(encode(decode({ ...snapshot, sample: ordered }))).toEqual({
      ...snapshot,
      sample: ordered,
    });
    const old = { _tag: "Sample", sample, cpu: statistic, memory: statistic, uptime: null };
    expect(decode(old)).not.toHaveProperty("statisticsSince");
    expect(decode(old)).not.toHaveProperty("sample.sequence");
    expect(() => decode({ ...live, sample: { ...ordered, sequence: -1 } })).toThrow();
    expect(() => decode({ ...live, sample: { ...ordered, ageMs: 1.5 } })).toThrow();
  });
});
