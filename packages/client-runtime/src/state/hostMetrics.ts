import type {
  ServerHostFacts,
  ServerHostMetricsChartBucket,
  ServerHostMetricsChartPoint,
  ServerHostMetricsEvent,
  ServerHostMetricsSample,
  ServerHostMetricsStatistic,
} from "@bibcode/contracts";
import * as Option from "effect/Option";

/** The recent chart covers this long before its newest point (the server's window, R69). */
export const HOST_METRICS_RECENT_WINDOW_MS = 15 * 60_000;
/** At most this many recent points, the server's own cap (D28). */
export const HOST_METRICS_RECENT_MAX_POINTS = 900;

/** What the host dashboard shows, built from one `server.subscribeHostMetrics` stream. */
export interface HostMetricsView {
  readonly bootId: string | null;
  readonly startedAt: string;
  readonly statisticsSince: string | null;
  readonly host: ServerHostFacts;
  readonly sample: ServerHostMetricsSample | null;
  readonly cpu: ServerHostMetricsStatistic | null;
  readonly memory: ServerHostMetricsStatistic | null;
  readonly recent: ReadonlyArray<ServerHostMetricsChartPoint>;
  readonly uptime: ReadonlyArray<ServerHostMetricsChartBucket>;
}

function chartPoint(sample: ServerHostMetricsSample): ServerHostMetricsChartPoint {
  return {
    sampledAt: sample.sampledAt,
    cpuPercent: sample.cpuPercent,
    memoryPercent:
      sample.memoryTotalBytes > 0 ? (sample.memoryUsedBytes / sample.memoryTotalBytes) * 100 : 0,
  };
}

/** Prunes by time first, so skipped samples never leave points older than the window (R85). */
function pruneRecent(
  points: ReadonlyArray<ServerHostMetricsChartPoint>,
): ReadonlyArray<ServerHostMetricsChartPoint> {
  const newest = points.at(-1);
  if (newest === undefined) return points;
  const cutoff = Date.parse(newest.sampledAt) - HOST_METRICS_RECENT_WINDOW_MS;
  const first = points.findIndex((point) => Date.parse(point.sampledAt) >= cutoff);
  return points.slice(Math.max(first, points.length - HOST_METRICS_RECENT_MAX_POINTS));
}

/**
 * Fields the server is asked to add to a sample (#292 review). The schema drops them until it
 * declares them, so each is read when present and its absence keeps today's rule.
 */
export interface HostMetricsSampleExtension {
  /** Rises by one per reading within a server run; orders samples whatever the wall clock does. */
  readonly sequence?: number;
  /** How old the reading was, on the server's own clock, when the item was encoded. */
  readonly ageMs?: number;
}

/** A Sample item may carry the statistics start once the server sends it there too. */
interface HostMetricsSampleEventExtension {
  readonly statisticsSince?: string | null;
}

function isNewerSample(
  previous: ServerHostMetricsSample & HostMetricsSampleExtension,
  next: ServerHostMetricsSample & HostMetricsSampleExtension,
): boolean {
  if (previous.sequence !== undefined && next.sequence !== undefined) {
    return next.sequence > previous.sequence;
  }
  return Date.parse(next.sampledAt) > Date.parse(previous.sampledAt);
}

/**
 * Folds stream items into the view, in the shape `Stream.mapAccum` takes: a Snapshot replaces
 * the view, a Sample newer than the last applied one updates it and appends a recent point, and
 * an uptime chart replaces the previous one whenever an item carries it.
 */
export function accumulateHostMetrics(
  previous: Option.Option<HostMetricsView>,
  event: ServerHostMetricsEvent,
): readonly [Option.Option<HostMetricsView>, ReadonlyArray<HostMetricsView>] {
  if (event._tag === "Snapshot") {
    const view: HostMetricsView = {
      bootId: event.bootId,
      startedAt: event.startedAt,
      statisticsSince: event.statisticsSince,
      host: event.host,
      sample: event.sample,
      cpu: event.cpu,
      memory: event.memory,
      recent: pruneRecent(event.recent),
      uptime: event.uptime,
    };
    return [Option.some(view), [view]];
  }
  const current = Option.getOrNull(previous);
  if (current === null) return [previous, []];
  if (current.sample !== null && !isNewerSample(current.sample, event.sample)) {
    // A stale or repeated sample changes nothing but may still carry a newer chart.
    if (event.uptime === null) return [previous, []];
    const view = { ...current, uptime: event.uptime };
    return [Option.some(view), [view]];
  }
  const view: HostMetricsView = {
    ...current,
    // After a Snapshot sent before the first reading, the first sample starts the statistics.
    // shortcut: without the server's own start, a coalesced first reading makes this a few
    // seconds late; exact once the server sends `statisticsSince` with samples.
    statisticsSince:
      current.statisticsSince ??
      (event as HostMetricsSampleEventExtension).statisticsSince ??
      event.sample.sampledAt,
    sample: event.sample,
    cpu: event.cpu,
    memory: event.memory,
    recent: pruneRecent([...current.recent, chartPoint(event.sample)]),
    uptime: event.uptime ?? current.uptime,
  };
  return [Option.some(view), [view]];
}
