import type {
  ServerHostMetricsChartBucket,
  ServerHostMetricsEvent,
  ServerHostMetricsSample,
  ServerHostMetricsStatistic,
} from "@bibcode/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import {
  accumulateHostMetrics,
  type HostMetricsSampleExtension,
  type HostMetricsView,
} from "./hostMetrics.ts";

const STATISTIC: ServerHostMetricsStatistic = {
  current: 20,
  minimum: 10,
  average: 15,
  p95: 19,
  maximum: 20,
};

function sample(sampledAt: string, cpuPercent = 20): ServerHostMetricsSample {
  return {
    sampledAt,
    cpuPercent,
    memoryTotalBytes: 1_000,
    memoryUsedBytes: 250,
    memoryAvailableBytes: 750,
    volumes: [],
    volumesPaused: false,
  };
}

function bucket(startedAt: string): ServerHostMetricsChartBucket {
  return {
    startedAt,
    durationMs: 60_000,
    cpuAverage: 10,
    cpuPeak: 20,
    memoryAverage: 30,
    memoryPeak: 40,
  };
}

function snapshot(
  recent: ReadonlyArray<string>,
  uptime: ReadonlyArray<ServerHostMetricsChartBucket> = [],
): ServerHostMetricsEvent {
  const last = recent.at(-1) ?? null;
  return {
    _tag: "Snapshot",
    host: { os: "linux", arch: "x86_64", cpuCount: 12, memoryTotalBytes: 1_000 },
    bootId: "boot-1",
    startedAt: "2026-11-11T19:00:00.000Z",
    statisticsSince: "2026-11-11T19:00:00.000Z",
    sample: last === null ? null : sample(last),
    cpu: STATISTIC,
    memory: STATISTIC,
    recent: recent.map((sampledAt) => ({ sampledAt, cpuPercent: 20, memoryPercent: 25 })),
    uptime,
  };
}

function sampleEvent(
  sampledAt: string,
  uptime: ReadonlyArray<ServerHostMetricsChartBucket> | null = null,
): ServerHostMetricsEvent {
  return {
    _tag: "Sample",
    sample: sample(sampledAt),
    cpu: STATISTIC,
    memory: STATISTIC,
    uptime,
  };
}

function run(events: ReadonlyArray<ServerHostMetricsEvent>): {
  readonly view: HostMetricsView;
  readonly emitted: number;
} {
  let state = Option.none<HostMetricsView>();
  let emitted = 0;
  for (const event of events) {
    const [next, out] = accumulateHostMetrics(state, event);
    state = next;
    emitted += out.length;
  }
  return { view: Option.getOrThrow(state), emitted };
}

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const at = (seconds: number) => iso(Date.UTC(2026, 10, 11, 19, 0, seconds));

describe("accumulateHostMetrics", () => {
  it("appends samples to the snapshot's recent points", () => {
    const { view, emitted } = run([
      snapshot([at(0), at(1)]),
      sampleEvent(at(2)),
      sampleEvent(at(3)),
    ]);
    expect(emitted).toBe(3);
    expect(view.recent.map((point) => point.sampledAt)).toEqual([at(0), at(1), at(2), at(3)]);
    expect(view.recent.at(-1)?.memoryPercent).toBe(25);
    expect(view.sample?.sampledAt).toBe(at(3));
    expect(view.host.cpuCount).toBe(12);
  });

  it("ignores a sample older than the last one applied", () => {
    const { view, emitted } = run([snapshot([at(0), at(5)]), sampleEvent(at(4))]);
    expect(emitted).toBe(1);
    expect(view.recent).toHaveLength(2);
    expect(view.sample?.sampledAt).toBe(at(5));
  });

  it("ignores a sample before any snapshot", () => {
    const [state, out] = accumulateHostMetrics(Option.none(), sampleEvent(at(1)));
    expect(Option.isNone(state)).toBe(true);
    expect(out).toEqual([]);
  });

  it("replaces the uptime chart only when a sample carries one", () => {
    const first = [bucket(at(0))];
    const second = [bucket(at(0)), bucket(at(60))];
    const kept = run([snapshot([at(0)], first), sampleEvent(at(1), null)]);
    expect(kept.view.uptime).toBe(first);
    const replaced = run([snapshot([at(0)], first), sampleEvent(at(1), second)]);
    expect(replaced.view.uptime).toBe(second);
  });

  it("keeps only points within 15 minutes of the newest after skipped samples", () => {
    const start = Date.UTC(2026, 10, 11, 19, 40, 0);
    const recent = Array.from({ length: 300 }, (_, index) => iso(start + index * 1_000));
    const { view } = run([snapshot(recent), sampleEvent("2026-11-11T20:00:01.000Z")]);
    const oldest = Date.parse(view.recent[0]!.sampledAt);
    expect(oldest).toBeGreaterThanOrEqual(Date.parse("2026-11-11T19:45:01.000Z"));
    expect(view.recent.at(-1)?.sampledAt).toBe("2026-11-11T20:00:01.000Z");
  });

  it("keeps at most 900 points", () => {
    const events: ServerHostMetricsEvent[] = [snapshot([at(0)])];
    for (let index = 1; index <= 1_000; index += 1) {
      events.push(sampleEvent(at(index)));
    }
    const { view } = run(events);
    expect(view.recent).toHaveLength(900);
    expect(view.recent.at(-1)?.sampledAt).toBe(at(1_000));
  });
});

/** A sample carrying the ordering fields the server is asked to add (#292 review). */
function orderedSampleEvent(
  sampledAt: string,
  extra: { readonly sequence?: number; readonly statisticsSince?: string },
): ServerHostMetricsEvent {
  const event = sampleEvent(sampledAt);
  if (event._tag !== "Sample") throw new Error("unreachable");
  return {
    ...event,
    ...(extra.statisticsSince === undefined ? {} : { statisticsSince: extra.statisticsSince }),
    sample: {
      ...event.sample,
      ...(extra.sequence === undefined ? {} : { sequence: extra.sequence }),
    },
  } as ServerHostMetricsEvent;
}

function emptySnapshot(): ServerHostMetricsEvent {
  const event = snapshot([]);
  return { ...event, statisticsSince: null, cpu: null, memory: null } as ServerHostMetricsEvent;
}

describe("accumulateHostMetrics after an empty snapshot", () => {
  it("takes the statistics start from the first sample", () => {
    const { view } = run([emptySnapshot(), sampleEvent(at(5)), sampleEvent(at(6))]);
    expect(view.statisticsSince).toBe(at(5));
    expect(view.cpu).toEqual(STATISTIC);
  });

  it("prefers the start the server sends with a sample", () => {
    const { view } = run([emptySnapshot(), orderedSampleEvent(at(5), { statisticsSince: at(2) })]);
    expect(view.statisticsSince).toBe(at(2));
  });
});

describe("accumulateHostMetrics ordering", () => {
  it("orders by the server's sequence, so a clock moved backwards keeps values live", () => {
    const first = snapshot([at(100)]);
    const sequenced: ServerHostMetricsSample & HostMetricsSampleExtension = {
      ...(first as { sample: ServerHostMetricsSample }).sample,
      sequence: 10,
    };
    const withSequence = { ...first, sample: sequenced } as ServerHostMetricsEvent;
    const { view, emitted } = run([
      withSequence,
      orderedSampleEvent(at(40), { sequence: 11 }),
      orderedSampleEvent(at(41), { sequence: 11 }),
      orderedSampleEvent(at(42), { sequence: 9 }),
      orderedSampleEvent(at(43), { sequence: 12 }),
    ]);
    expect(emitted).toBe(3);
    expect(view.sample?.sampledAt).toBe(at(43));
  });

  it("falls back to the timestamp when a sample has no sequence", () => {
    const { view, emitted } = run([snapshot([at(100)]), sampleEvent(at(40))]);
    expect(emitted).toBe(1);
    expect(view.sample?.sampledAt).toBe(at(100));
  });
});
