import type {
  ServerProviderUsageResetCredits,
  ServerProviderUsageSnapshot,
  ServerProviderUsageWindow,
  ServerProviderUsageWindowGroup,
} from "@bibcode/contracts";
import * as DateTime from "effect/DateTime";

import {
  clampPercent,
  formatProviderResetLabel,
  formatProviderUsagePercent,
  formatProviderWindowLabel,
  providerUsageBarColorClass,
} from "./statusBarFormat";

export type UsageWindowKey = string;
export type UsagePercentageDisplay = "remaining" | "used";

export interface UsageWindowViewModel {
  readonly key: UsageWindowKey;
  readonly label: string;
  readonly windowLabel: string;
  readonly consumedPercent: number;
  readonly displayedPercent: number;
  readonly fillPercent: number;
  readonly percentageLabel: string;
  readonly resetLabel: string | null;
  readonly resetsAt: ServerProviderUsageWindow["resetsAt"];
  readonly resetDescription: string | null;
  /** Color intentionally continues to reflect consumed urgency in both display modes. */
  readonly barColorClass: string;
}

export interface ProviderUsagePlanViewModel {
  readonly value: string;
  readonly label: string;
}

export interface ProviderUsageCreditsViewModel {
  readonly availableCount: number;
  readonly totalEarnedCount: number | null;
  readonly nextExpiresAt: ServerProviderUsageResetCredits["nextExpiresAt"];
  readonly nextExpiresLabel: string | null;
}

export interface UsageWindowGroupViewModel {
  readonly id: ServerProviderUsageWindowGroup["id"];
  readonly label: string;
  readonly windows: ReadonlyArray<UsageWindowViewModel>;
}

export interface ProviderUsageViewModel {
  readonly provider: ServerProviderUsageSnapshot["provider"];
  readonly status: ServerProviderUsageSnapshot["status"];
  readonly windows: ReadonlyArray<UsageWindowViewModel>;
  readonly detailedWindows: ReadonlyArray<UsageWindowViewModel>;
  readonly compactWindows: ReadonlyArray<UsageWindowViewModel>;
  /** One section per quota group (Antigravity); empty for a provider with flat windows. */
  readonly groups: ReadonlyArray<UsageWindowGroupViewModel>;
  readonly plan: ProviderUsagePlanViewModel | null;
  readonly credits: ProviderUsageCreditsViewModel | null;
  /** Null for a placeholder: nothing was read, so there is no time to show. */
  readonly updatedAt: ServerProviderUsageSnapshot["updatedAt"] | null;
  readonly error: string | null;
}

export interface ProviderUsagePresentationOptions {
  readonly now?: DateTime.Utc;
  readonly percentageDisplay?: UsagePercentageDisplay;
}

const WINDOW_DEFINITIONS: ReadonlyArray<{
  readonly key: UsageWindowKey;
  readonly label: UsageWindowViewModel["label"];
  readonly snapshotKey: "session" | "weekly" | "fableWeekly";
}> = [
  { key: "session", label: "Session", snapshotKey: "session" },
  { key: "weekly", label: "Weekly", snapshotKey: "weekly" },
  { key: "fable", label: "Fable", snapshotKey: "fableWeekly" },
];

// Lookups with no default: a provider this build does not know renders nothing, never another
// provider's name or icon.
const PROVIDER_LABEL: Readonly<Record<ServerProviderUsageSnapshot["provider"], string>> = {
  claude: "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
};

export function providerUsageLabel(
  provider: ServerProviderUsageSnapshot["provider"],
): string | null {
  return Object.hasOwn(PROVIDER_LABEL, provider) ? PROVIDER_LABEL[provider] : null;
}

const GROUP_SHORT_LABEL: Readonly<Record<ServerProviderUsageWindowGroup["id"], string>> = {
  gemini: "Gemini",
  "third-party": "Claude/GPT",
  other: "Other",
};

/** The server's sentence for a provider it has not read yet: a placeholder, not data. */
export const NOT_FETCHED_MESSAGE = "Provider usage has not been fetched yet.";

function groupWindows(
  group: ServerProviderUsageWindowGroup,
): ReadonlyArray<{ key: string; label: string; window: ServerProviderUsageWindow }> {
  return (
    [
      ["session", "5-hour", group.session],
      ["weekly", "Weekly", group.weekly],
    ] as const
  ).flatMap(([slot, label, window]) =>
    window === null ? [] : [{ key: `${group.id}-${slot}`, label, window }],
  );
}

function groupWindowDefinitions(
  snapshot: ServerProviderUsageSnapshot,
): ReadonlyArray<{ key: string; label: string; window: ServerProviderUsageWindow }> {
  return snapshot.windowGroups.flatMap(groupWindows);
}

function titleCasePlan(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1).toLowerCase()}`)
    .join(" ");
}

function buildWindowViewModel(input: {
  readonly key: UsageWindowKey;
  readonly label: UsageWindowViewModel["label"];
  readonly window: ServerProviderUsageWindow;
  readonly now: DateTime.Utc;
  readonly percentageDisplay: UsagePercentageDisplay;
}): UsageWindowViewModel {
  const consumedPercent = clampPercent(input.window.usedPercent);
  const displayedPercent =
    input.percentageDisplay === "remaining" ? 100 - consumedPercent : consumedPercent;

  return {
    key: input.key,
    label: input.label,
    windowLabel: formatProviderWindowLabel(input.window),
    consumedPercent,
    displayedPercent,
    fillPercent: displayedPercent,
    percentageLabel: formatProviderUsagePercent(consumedPercent, input.percentageDisplay),
    resetLabel: formatProviderResetLabel(
      input.window.resetsAt,
      input.window.resetDescription,
      input.now,
    ),
    resetsAt: input.window.resetsAt,
    resetDescription: input.window.resetDescription,
    barColorClass: providerUsageBarColorClass(consumedPercent),
  };
}

function buildCreditsViewModel(
  credits: ServerProviderUsageResetCredits | null,
  now: DateTime.Utc,
): ProviderUsageCreditsViewModel | null {
  if (credits === null) return null;
  return {
    availableCount: credits.availableCount,
    totalEarnedCount: credits.totalEarnedCount,
    nextExpiresAt: credits.nextExpiresAt,
    nextExpiresLabel:
      credits.nextExpiresAt === null
        ? null
        : formatProviderResetLabel(credits.nextExpiresAt, null, now),
  };
}

export function buildProviderUsageViewModel(
  snapshot: ServerProviderUsageSnapshot,
  options: ProviderUsagePresentationOptions = {},
): ProviderUsageViewModel {
  const now = options.now ?? DateTime.nowUnsafe();
  const percentageDisplay = options.percentageDisplay ?? "remaining";
  // Only live or retained data has meters: an expired or unavailable snapshot shows its sentence.
  const groups =
    snapshot.status === "ok" || snapshot.status === "error"
      ? snapshot.windowGroups.map((group) => ({
          id: group.id,
          label: group.label,
          windows: groupWindows(group).map((definition) =>
            buildWindowViewModel({ ...definition, now, percentageDisplay }),
          ),
        }))
      : [];
  const windows = [
    ...WINDOW_DEFINITIONS.flatMap((definition) => {
      const window = snapshot[definition.snapshotKey];
      return window === null
        ? []
        : [
            buildWindowViewModel({
              ...definition,
              window,
              now,
              percentageDisplay,
            }),
          ];
    }),
    // In the status bar a group window needs its group's name.
    ...groups.flatMap((group) =>
      group.windows.map((window) => ({
        ...window,
        label: `${GROUP_SHORT_LABEL[group.id]} ${window.label.toLowerCase()}`,
      })),
    ),
  ];
  const tightestWindow = windows.reduce<UsageWindowViewModel | null>(
    (tightest, window) =>
      tightest === null || window.consumedPercent > tightest.consumedPercent ? window : tightest,
    null,
  );
  const plan =
    snapshot.planType === null
      ? null
      : (() => {
          const label = titleCasePlan(snapshot.planType);
          return label.length === 0 ? null : { value: snapshot.planType, label };
        })();

  const compactWindows = tightestWindow === null ? [] : [tightestWindow];

  return {
    provider: snapshot.provider,
    status: snapshot.status,
    windows,
    // Several groups do not fit the bar: it shows the tightest window, the popover the groups.
    detailedWindows: groups.length > 0 ? compactWindows : windows,
    compactWindows,
    groups,
    plan,
    credits: buildCreditsViewModel(snapshot.rateLimitResetCredits, now),
    updatedAt: snapshot.error === NOT_FETCHED_MESSAGE ? null : snapshot.updatedAt,
    error: snapshot.error,
  };
}

export type AntigravityPlaceholder = "loading" | "failed" | "unsupported";

const ANTIGRAVITY_PLACEHOLDER_ERROR: Readonly<Record<AntigravityPlaceholder, string | null>> = {
  loading: null,
  failed: "Could not load Antigravity usage. Use the refresh button to try again.",
  unsupported: "This BiBCode server is too old to show Antigravity usage.",
};

/** The Antigravity item before it has a snapshot, after a failed read, or on an old server. */
export function antigravityPlaceholderViewModel(
  placeholder: AntigravityPlaceholder,
): ProviderUsageViewModel {
  return {
    provider: "antigravity",
    status: placeholder === "loading" ? "fetching" : "unavailable",
    windows: [],
    detailedWindows: [],
    compactWindows: [],
    groups: [],
    plan: null,
    credits: null,
    updatedAt: null,
    error: ANTIGRAVITY_PLACEHOLDER_ERROR[placeholder],
  };
}

export function buildProviderUsageViewModels(
  snapshots: ReadonlyArray<ServerProviderUsageSnapshot>,
  options: ProviderUsagePresentationOptions = {},
): ReadonlyArray<ProviderUsageViewModel> {
  return snapshots.map((snapshot) => buildProviderUsageViewModel(snapshot, options));
}

export function providerUsageRelativeLabelKey(
  snapshots: ReadonlyArray<ServerProviderUsageSnapshot>,
  now: DateTime.Utc,
): string {
  return JSON.stringify(
    snapshots.flatMap((snapshot) => [
      ...WINDOW_DEFINITIONS.map(({ snapshotKey }) => {
        const window = snapshot[snapshotKey];
        return window === null || window.resetsAt === null
          ? null
          : formatProviderResetLabel(window.resetsAt, null, now);
      }),
      ...groupWindowDefinitions(snapshot).map(({ window }) =>
        window.resetsAt === null ? null : formatProviderResetLabel(window.resetsAt, null, now),
      ),
      snapshot.rateLimitResetCredits?.nextExpiresAt === null ||
      snapshot.rateLimitResetCredits?.nextExpiresAt === undefined
        ? null
        : formatProviderResetLabel(snapshot.rateLimitResetCredits.nextExpiresAt, null, now),
    ]),
  );
}
