import type { EnvironmentActivityState } from "@bibcode/client-runtime/state/activity";
import type {
  ActivityLifecycle,
  ActivitySectionHealth,
  ActivitySnapshot,
} from "@bibcode/contracts";
import * as Option from "effect/Option";

export interface ActivityDockVisibility {
  readonly visible: boolean;
  readonly showSubagents: boolean;
  readonly showBackgroundTasks: boolean;
}

export function activitySnapshotForState(state: EnvironmentActivityState): ActivitySnapshot | null {
  return Option.match(state.snapshot, {
    onNone: () => null,
    onSome: (snapshot) => {
      if (Option.isSome(state.error) && snapshot.observationState !== "error") {
        return { ...snapshot, observationState: "error" };
      }
      return state.status === "stale" && snapshot.observationState === "live"
        ? { ...snapshot, observationState: "stale" }
        : snapshot;
    },
  });
}

function hasRecords(counts: { readonly active: number; readonly done: number }): boolean {
  return counts.active > 0 || counts.done > 0;
}

function isSectionVisible(
  capability: boolean,
  health: ActivitySectionHealth,
  counts: { readonly active: number; readonly done: number },
  alwaysVisible: boolean,
): boolean {
  if (health.state === "unsupported") {
    return false;
  }
  if (!hasRecords(counts)) {
    // An empty section shows only when the provider claims it, so an idle
    // button never stands in for activity BiBCode cannot see.
    return alwaysVisible && capability;
  }
  return capability || health.state === "stale" || health.state === "error";
}

export function selectActivityDockVisibility(
  snapshot: ActivitySnapshot | null,
  { alwaysVisible = false }: { readonly alwaysVisible?: boolean } = {},
): ActivityDockVisibility {
  if (snapshot === null) {
    return {
      visible: false,
      showSubagents: false,
      showBackgroundTasks: false,
    };
  }

  const showSubagents = isSectionVisible(
    snapshot.capabilities.actors,
    snapshot.sections.subagents,
    snapshot.counts.subagents,
    alwaysVisible,
  );
  const showBackgroundTasks = isSectionVisible(
    snapshot.capabilities.backgroundWork,
    snapshot.sections.backgroundTasks,
    snapshot.counts.backgroundTasks,
    alwaysVisible,
  );
  return {
    visible: showSubagents || showBackgroundTasks,
    showSubagents,
    showBackgroundTasks,
  };
}

export function activityStatusLabel(status: ActivityLifecycle): string {
  switch (status) {
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "waiting":
      return "Waiting";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "interrupted":
      return "Interrupted";
    case "unknown":
      return "Unknown";
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

export function isActivityLifecycleActive(status: ActivityLifecycle): boolean {
  return (
    status === "starting" || status === "running" || status === "waiting" || status === "unknown"
  );
}

const RFC3339_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

interface ParsedRfc3339Instant {
  readonly epochSecondMs: number;
  readonly fraction: string;
}

function parseRfc3339Instant(value: string): ParsedRfc3339Instant | null {
  const match = RFC3339_INSTANT_PATTERN.exec(value);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? "";
  const zone = match[8]!;
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 14 ||
    offsetMinute > 59 ||
    (offsetHour === 14 && offsetMinute !== 0)
  ) {
    return null;
  }

  const epochSecondMs = Date.parse(`${value.slice(0, 19)}${zone}`);
  return Number.isFinite(epochSecondMs) ? { epochSecondMs, fraction } : null;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareActivityTimestamps(left: string, right: string): number {
  const leftInstant = parseRfc3339Instant(left);
  const rightInstant = parseRfc3339Instant(right);
  if (leftInstant === null || rightInstant === null) {
    return compareText(left, right);
  }
  if (leftInstant.epochSecondMs !== rightInstant.epochSecondMs) {
    return leftInstant.epochSecondMs < rightInstant.epochSecondMs ? -1 : 1;
  }
  const fractionLength = Math.max(leftInstant.fraction.length, rightInstant.fraction.length);
  return compareText(
    leftInstant.fraction.padEnd(fractionLength, "0"),
    rightInstant.fraction.padEnd(fractionLength, "0"),
  );
}

export function activityElapsedLabel(startedAt: string, now: string): string {
  const startedAtInstant = parseRfc3339Instant(startedAt);
  const nowInstant = parseRfc3339Instant(now);
  if (startedAtInstant === null || nowInstant === null) {
    return "0s";
  }
  const startedAtMs =
    startedAtInstant.epochSecondMs + Number(startedAtInstant.fraction.slice(0, 3).padEnd(3, "0"));
  const nowMs = nowInstant.epochSecondMs + Number(nowInstant.fraction.slice(0, 3).padEnd(3, "0"));

  const elapsedSeconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1_000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `${elapsedHours}h`;
  }

  return `${Math.floor(elapsedHours / 24)}d`;
}

/**
 * The time a roster row shows: how long it ran, named by how it ended. A
 * record BiBCode closed because its process ended reads as interrupted, never
 * completed; its summary says why and when it last reported. Nothing here
 * depends on the current time once the record ended, so the label never goes
 * stale.
 */
export function activityRecordTimeLabel(
  record: {
    readonly status: ActivityLifecycle;
    readonly startedAt: string;
    readonly terminalAt: string | null;
  },
  now: string,
): string {
  if (isActivityLifecycleActive(record.status) || record.terminalAt === null) {
    return `Elapsed ${activityElapsedLabel(record.startedAt, now)}`;
  }
  const ranFor = activityElapsedLabel(record.startedAt, record.terminalAt);
  switch (record.status) {
    case "failed":
      return `Failed after ${ranFor}`;
    case "cancelled":
      return `Stopped after ${ranFor}`;
    case "interrupted":
      return `Interrupted after ${ranFor}`;
    default:
      return `Completed in ${ranFor}`;
  }
}

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  claude: "Claude",
  claudeAgent: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor",
  grok: "Grok",
};

/** Why a running subagent has no Stop, without promising another way to end it. */
export function activityStopUnavailableReason(provider: string): string {
  const label = Object.hasOwn(PROVIDER_LABELS, provider) ? PROVIDER_LABELS[provider] : undefined;
  return `${label ?? "The provider"} doesn't offer a way to stop this subagent from BiBCode.`;
}
