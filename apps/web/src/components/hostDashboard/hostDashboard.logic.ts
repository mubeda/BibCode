import type {
  HostMetricsSampleExtension,
  HostMetricsView,
} from "@bibcode/client-runtime/state/server";
import type {
  ServerHostMetricsChartBucket,
  ServerHostMetricsChartPoint,
  ServerHostMetricsStatistic,
  ServerHostMetricsVolume,
} from "@bibcode/contracts";
import type { TimestampFormat } from "@bibcode/contracts/settings";

import {
  formatElapsedDurationLabel,
  formatChatTimestampTooltip,
  formatShortTimestamp,
  formatTimestamp,
} from "../../timestampFormat";
import { formatCpuPercent, formatMemoryBytes } from "../status-bar/statusBarFormat";

export type HostDashboardState =
  | "loading"
  | "live"
  | "stale"
  | "disconnected"
  | "restarted"
  | "unsupported"
  | "error";

/** R73's text for a server whose descriptor has no `hostMetrics`. */
export const HOST_METRICS_UNSUPPORTED_MESSAGE =
  "This server's version doesn't report host metrics. Update it to see this dashboard.";

/** No item for this long while subscribed dims the values (R77). */
export const HOST_DASHBOARD_STALE_AFTER_MS = 3_000;

export interface HostDashboardVolumeRow {
  readonly key: string;
  readonly mountPoint: string;
  readonly name: string;
  /** "1.4 GB of 2.0 GB", or null before the volume first answered. */
  readonly usage: string | null;
  readonly free: string | null;
  readonly usedPercent: number | null;
  readonly badges: ReadonlyArray<"Removable" | "Read-only" | "Not responding">;
}

export interface HostDashboardStatisticRow {
  readonly label: "CPU" | "Memory";
  readonly figures: ReadonlyArray<{
    readonly label: "Current" | "Minimum" | "Average" | "p95" | "Maximum";
    readonly value: string;
  }>;
}

export interface HostDashboardValues {
  readonly sampledAt: string | null;
  readonly cpu: string;
  readonly cores: string;
  readonly memory: string;
  readonly volumes: ReadonlyArray<HostDashboardVolumeRow>;
  readonly volumesPaused: boolean;
  /** "Since <time> (up <duration>)", or null before the first reading. */
  readonly since: string | null;
  readonly statistics: ReadonlyArray<HostDashboardStatisticRow>;
}

export interface HostDashboardPresentation {
  readonly state: HostDashboardState;
  readonly dimmed: boolean;
  readonly notice: string | null;
  /** Null shows skeletons. */
  readonly values: HostDashboardValues | null;
}

/** The stream runs only while the sheet can be seen (R78); window focus is deliberately no input (D30). */
export function shouldSubscribeToHostMetrics(input: {
  readonly open: boolean;
  readonly visible: boolean;
  readonly connected: boolean;
  readonly supported: boolean;
}): boolean {
  return input.open && input.visible && input.connected && input.supported;
}

/** A different boot ID; when either side has none, a different start time. */
export function isServerRestart(previous: HostMetricsView, next: HostMetricsView): boolean {
  if (previous.bootId !== null && next.bootId !== null) return previous.bootId !== next.bootId;
  return previous.startedAt !== next.startedAt;
}

function percentOf(part: number, total: number): number {
  return total > 0 ? (part / total) * 100 : 0;
}

function volumeRow(volume: ServerHostMetricsVolume): HostDashboardVolumeRow {
  const badges: Array<HostDashboardVolumeRow["badges"][number]> = [];
  if (volume.removable) badges.push("Removable");
  if (volume.readOnly) badges.push("Read-only");
  if (volume.state === "notResponding") badges.push("Not responding");
  const sized = volume.totalBytes !== null && volume.usedBytes !== null;
  return {
    key: volume.mountPoint,
    mountPoint: volume.mountPoint,
    name: volume.name,
    usage: sized
      ? `${formatMemoryBytes(volume.usedBytes!)} of ${formatMemoryBytes(volume.totalBytes!)}`
      : null,
    free: volume.freeBytes === null ? null : `${formatMemoryBytes(volume.freeBytes)} free`,
    usedPercent: sized ? percentOf(volume.usedBytes!, volume.totalBytes!) : null,
    badges,
  };
}

function statisticRow(
  label: HostDashboardStatisticRow["label"],
  statistic: ServerHostMetricsStatistic,
): HostDashboardStatisticRow {
  return {
    label,
    figures: [
      { label: "Current", value: formatCpuPercent(statistic.current) },
      { label: "Minimum", value: formatCpuPercent(statistic.minimum) },
      { label: "Average", value: formatCpuPercent(statistic.average) },
      { label: "p95", value: formatCpuPercent(statistic.p95) },
      { label: "Maximum", value: formatCpuPercent(statistic.maximum) },
    ],
  };
}

function presentValues(
  view: HostMetricsView,
  nowMs: number,
  timestampFormat: TimestampFormat,
): HostDashboardValues {
  const sample = view.sample;
  const cpuCount = view.host.cpuCount;
  const memoryTotal = sample?.memoryTotalBytes ?? view.host.memoryTotalBytes;
  const memoryUsed = sample?.memoryUsedBytes ?? null;
  const uptime = formatElapsedDurationLabel(view.startedAt, nowMs);
  const statistics: HostDashboardStatisticRow[] = [];
  if (view.cpu !== null) statistics.push(statisticRow("CPU", view.cpu));
  if (view.memory !== null) statistics.push(statisticRow("Memory", view.memory));
  return {
    sampledAt: sample?.sampledAt ?? null,
    cpu: sample === null ? "Unavailable" : formatCpuPercent(sample.cpuPercent),
    cores: `${cpuCount} ${cpuCount === 1 ? "core" : "cores"}`,
    memory:
      memoryUsed === null
        ? `${formatMemoryBytes(memoryTotal)} total`
        : `${formatMemoryBytes(memoryUsed)} of ${formatMemoryBytes(memoryTotal)}, ${Math.round(
            percentOf(memoryUsed, memoryTotal),
          )}%`,
    volumes: sample?.volumes.map(volumeRow) ?? [],
    volumesPaused: sample?.volumesPaused ?? false,
    since:
      view.statisticsSince === null
        ? null
        : `Since ${formatChatTimestampTooltip(view.statisticsSince, timestampFormat)} (${
            uptime === "just now" ? "just started" : `up ${uptime}`
          })`,
    statistics,
  };
}

export function presentHostDashboard(input: {
  /** The current stream's view, null before its first snapshot or while not subscribed. */
  readonly view: HostMetricsView | null;
  /** The view shown before the current subscription started; it detects a restart. */
  readonly shownView: HostMetricsView | null;
  readonly connected: boolean;
  /** `capabilities.hostMetrics`; null while the server's config is not known yet. */
  readonly supported: boolean | null;
  readonly failure: string | null;
  /** When the client last received an item, on its own clock. */
  readonly lastItemAtMs: number | null;
  readonly nowMs: number;
  readonly timestampFormat?: TimestampFormat;
}): HostDashboardPresentation {
  const timestampFormat = input.timestampFormat ?? "locale";
  const shown = input.view ?? input.shownView;
  const values = shown === null ? null : presentValues(shown, input.nowMs, timestampFormat);
  // A dropped connection also fails the stream, so disconnected wins over error.
  if (!input.connected) {
    return { state: "disconnected", dimmed: true, notice: "Disconnected", values };
  }
  if (input.supported === false) {
    return {
      state: "unsupported",
      dimmed: false,
      notice: HOST_METRICS_UNSUPPORTED_MESSAGE,
      values: null,
    };
  }
  if (input.failure !== null) {
    return { state: "error", dimmed: true, notice: input.failure, values };
  }
  if (input.supported === null || input.view === null) {
    return { state: "loading", dimmed: values !== null, notice: null, values };
  }
  // The reading's age as the server saw it when it sent it, plus the time since it arrived; a
  // server that does not send the age leaves receipt time alone (both clocks stay unmixed).
  const sampleAgeMs =
    (input.view.sample as (HostMetricsSampleExtension & object) | null)?.ageMs ?? 0;
  const silentMs =
    (input.lastItemAtMs === null ? 0 : input.nowMs - input.lastItemAtMs) + sampleAgeMs;
  if (silentMs >= HOST_DASHBOARD_STALE_AFTER_MS) {
    return {
      state: "stale",
      dimmed: true,
      notice: `Last updated ${Math.floor(silentMs / 1_000)} s ago`,
      values,
    };
  }
  if (input.shownView !== null && isServerRestart(input.shownView, input.view)) {
    return {
      state: "restarted",
      dimmed: false,
      notice: `Server restarted at ${formatShortTimestamp(input.view.startedAt, timestampFormat)}`,
      values,
    };
  }
  return { state: "live", dimmed: false, notice: null, values };
}

export type HostMetricMeasure = "cpu" | "memory";

export interface HostMetricBar {
  readonly key: string;
  readonly average: number;
  readonly peak: number;
  readonly tooltip: string;
}

/** Each recent bar covers one aligned slot, so 15 minutes draw about 60 bars. */
export const HOST_DASHBOARD_RECENT_SLOT_MS = 15_000;

function barTooltip(time: string, average: number, peak: number): string {
  return `${time}: average ${formatCpuPercent(average)}, peak ${formatCpuPercent(peak)}`;
}

/**
 * Groups recent readings into bars of average and peak per aligned 15 s slot, keyed by the
 * slot's start, so a new reading changes only the newest bar and older bars keep their tooltips.
 */
export function hostMetricsRecentBars(
  recent: ReadonlyArray<ServerHostMetricsChartPoint>,
  measure: HostMetricMeasure,
  timestampFormat: TimestampFormat,
): ReadonlyArray<HostMetricBar> {
  const slots: Array<{ startMs: number; values: number[] }> = [];
  for (const point of recent) {
    const startMs =
      Math.floor(Date.parse(point.sampledAt) / HOST_DASHBOARD_RECENT_SLOT_MS) *
      HOST_DASHBOARD_RECENT_SLOT_MS;
    const value = measure === "cpu" ? point.cpuPercent : point.memoryPercent;
    const last = slots.at(-1);
    if (last !== undefined && last.startMs === startMs) last.values.push(value);
    else slots.push({ startMs, values: [value] });
  }
  const seen = new Set<string>();
  return slots.map(({ startMs, values }) => {
    const label = new Date(startMs).toISOString();
    // A clock moved backwards can revisit a slot; the repeat gets its own key.
    let key = label;
    for (let repeat = 1; seen.has(key); repeat += 1) key = `${label}#${repeat}`;
    seen.add(key);
    const average = values.reduce((sum, value) => sum + value, 0) / values.length;
    const peak = Math.max(...values);
    return {
      key,
      average,
      peak,
      tooltip: barTooltip(formatTimestamp(label, timestampFormat), average, peak),
    };
  });
}

/** One bar per uptime bucket; the server sends at most 240 (D28). */
export function hostMetricsUptimeBars(
  uptime: ReadonlyArray<ServerHostMetricsChartBucket>,
  measure: HostMetricMeasure,
  timestampFormat: TimestampFormat,
): ReadonlyArray<HostMetricBar> {
  return uptime.map((bucket) => {
    const average = measure === "cpu" ? bucket.cpuAverage : bucket.memoryAverage;
    const peak = measure === "cpu" ? bucket.cpuPeak : bucket.memoryPeak;
    return {
      key: bucket.startedAt,
      average,
      peak,
      tooltip: barTooltip(
        formatChatTimestampTooltip(bucket.startedAt, timestampFormat),
        average,
        peak,
      ),
    };
  });
}
