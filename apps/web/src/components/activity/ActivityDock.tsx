import {
  ACTIVITY_PAGE_MAX_LENGTH,
  type ActivityLifecycle,
  type ActivitySection,
  type ActivitySnapshot,
} from "@bibcode/contracts";
import { BotIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { PROVIDER_ICON_BY_PROVIDER } from "~/components/chat/providerIconUtils";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { ACTIVITY_DOCK_SHEET_INSET_CLASS_NAME } from "~/rightPanelLayout";
import { compareActivityTimestamps, selectActivityDockVisibility } from "./activityPresentation";

const LIVE_ANNOUNCEMENT_WINDOW_MS = 500;

function safeCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(Math.trunc(value), Number.MAX_SAFE_INTEGER);
}

function addCounts(left: number, right: number): number {
  const total = left + right;
  return Number.isSafeInteger(total) ? total : Number.MAX_SAFE_INTEGER;
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function resolveProviderIcon(provider: string) {
  if (!Object.hasOwn(PROVIDER_ICON_BY_PROVIDER, provider)) {
    return BotIcon;
  }
  const icon = PROVIDER_ICON_BY_PROVIDER[provider as ActivitySnapshot["provider"]];
  return typeof icon === "function" ? icon : BotIcon;
}

function renderProviderIcon(provider: string, className: string) {
  const ProviderIcon = resolveProviderIcon(provider);
  return <ProviderIcon className={className} />;
}

interface ActivityDockRecord {
  readonly updatedAt: string;
}

interface ActivityDockViewModel {
  readonly provider: string;
  readonly observationState: ActivitySnapshot["observationState"];
  readonly sections: ActivitySnapshot["sections"];
  readonly counts: ActivitySnapshot["counts"];
  readonly actors: ReadonlyArray<ActivityDockRecord>;
  readonly workItems: ReadonlyArray<ActivityDockRecord>;
  readonly visibility: ReturnType<typeof selectActivityDockVisibility>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isActivityLifecycle(value: unknown): value is ActivityLifecycle {
  return (
    value === "starting" ||
    value === "running" ||
    value === "waiting" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "interrupted" ||
    value === "unknown"
  );
}

function normalizeSectionHealth(value: unknown): ActivitySnapshot["sections"]["subagents"] {
  const state =
    isObject(value) &&
    (value.state === "live" ||
      value.state === "stale" ||
      value.state === "error" ||
      value.state === "unsupported")
      ? value.state
      : "unsupported";
  return { state, message: null, retryable: false };
}

function normalizeSectionCounts(value: unknown): ActivitySnapshot["counts"]["subagents"] {
  return {
    active: safeCount(isObject(value) ? value.active : undefined),
    done: safeCount(isObject(value) ? value.done : undefined),
  };
}

function normalizeRecord(value: unknown): ActivityDockRecord | null {
  if (
    !isObject(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    !isActivityLifecycle(value.status) ||
    typeof value.startedAt !== "string"
  ) {
    return null;
  }
  return { updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : value.startedAt };
}

function normalizeRecords(values: ReadonlyArray<unknown>): ReadonlyArray<ActivityDockRecord> {
  const records: ActivityDockRecord[] = [];
  const length = Math.min(values.length, ACTIVITY_PAGE_MAX_LENGTH);
  for (let index = 0; index < length; index += 1) {
    const record = normalizeRecord(values[index]);
    if (record !== null) {
      records.push(record);
    }
  }
  return records;
}

function normalizeActivityDockSnapshot(
  snapshot: unknown,
  alwaysVisible: boolean,
): ActivityDockViewModel | null {
  if (!isObject(snapshot)) {
    return null;
  }
  const capabilities = snapshot.capabilities;
  const sections = snapshot.sections;
  const counts = snapshot.counts;
  const actors = snapshot.actors;
  const workItems = snapshot.workItems;
  if (
    !isObject(capabilities) ||
    !isObject(sections) ||
    !isObject(counts) ||
    !Array.isArray(actors) ||
    !Array.isArray(workItems)
  ) {
    return null;
  }

  const normalizedSections = {
    subagents: normalizeSectionHealth(sections.subagents),
    backgroundTasks: normalizeSectionHealth(sections.backgroundTasks),
  };
  const normalizedCounts = {
    subagents: normalizeSectionCounts(counts.subagents),
    backgroundTasks: normalizeSectionCounts(counts.backgroundTasks),
  };
  const visibilitySnapshot = {
    capabilities: {
      actors: capabilities.actors === true,
      backgroundWork: capabilities.backgroundWork === true,
    },
    sections: normalizedSections,
    counts: normalizedCounts,
  } as unknown as ActivitySnapshot;
  const visibility = selectActivityDockVisibility(visibilitySnapshot, { alwaysVisible });

  return {
    provider:
      typeof snapshot.provider === "string" && snapshot.provider.length > 0
        ? snapshot.provider
        : "unknown",
    observationState:
      snapshot.observationState === "reconnecting" ||
      snapshot.observationState === "stale" ||
      snapshot.observationState === "error"
        ? snapshot.observationState
        : "live",
    sections: normalizedSections,
    counts: normalizedCounts,
    actors: visibility.showSubagents ? normalizeRecords(actors) : [],
    workItems: visibility.showBackgroundTasks ? normalizeRecords(workItems) : [],
    visibility,
  };
}

type DegradedState = "stale" | "error";

function degradedSectionState(state: string): DegradedState | null {
  return state === "stale" || state === "error" ? state : null;
}

function DegradedStatus({ state }: { readonly state: DegradedState | null }) {
  if (state === null) {
    return null;
  }
  const Icon = state === "error" ? TriangleAlertIcon : RefreshCwIcon;
  return (
    <span
      aria-hidden="true"
      className="flex size-4 shrink-0 items-center justify-center text-muted-foreground"
      data-activity-status={state}
    >
      <Icon className="size-3.5" />
    </span>
  );
}

interface SectionSummary {
  readonly active: number;
  readonly done: number;
  readonly state: DegradedState | null;
  readonly latest: string | null;
}

function latestUpdate(records: ReadonlyArray<ActivityDockRecord>): string | null {
  let latest: string | null = null;
  for (const record of records) {
    if (latest === null || compareActivityTimestamps(record.updatedAt, latest) > 0) {
      latest = record.updatedAt;
    }
  }
  return latest;
}

function summarizeSection(
  shown: boolean,
  counts: ActivitySnapshot["counts"]["subagents"],
  health: ActivitySnapshot["sections"]["subagents"],
  records: ReadonlyArray<ActivityDockRecord>,
): SectionSummary {
  return shown
    ? {
        active: counts.active,
        done: counts.done,
        state: degradedSectionState(health.state),
        latest: latestUpdate(records),
      }
    : { active: 0, done: 0, state: null, latest: null };
}

/**
 * The section a click opens: the failing one, else the one with running work
 * (Subagents first), else the one whose latest record is newest.
 */
function sectionToOpen(
  visibility: ActivityDockViewModel["visibility"],
  subagents: SectionSummary,
  backgroundTasks: SectionSummary,
): ActivitySection {
  if (subagents.state === "error" || backgroundTasks.state === "error") {
    return subagents.state === "error" ? "subagents" : "backgroundTasks";
  }
  if (subagents.active > 0 || backgroundTasks.active > 0) {
    return subagents.active > 0 ? "subagents" : "backgroundTasks";
  }
  if (subagents.latest !== null && backgroundTasks.latest !== null) {
    return compareActivityTimestamps(backgroundTasks.latest, subagents.latest) > 0
      ? "backgroundTasks"
      : "subagents";
  }
  if (backgroundTasks.latest !== null) {
    return "backgroundTasks";
  }
  return visibility.showSubagents ? "subagents" : "backgroundTasks";
}

function ActivityLiveAnnouncement({ announcement }: { readonly announcement: string }) {
  const [published, setPublished] = useState(announcement);
  const initialAnnouncement = useRef(true);

  useEffect(() => {
    if (initialAnnouncement.current) {
      initialAnnouncement.current = false;
      return;
    }
    const timer = window.setTimeout(() => setPublished(announcement), LIVE_ANNOUNCEMENT_WINDOW_MS);
    return () => window.clearTimeout(timer);
  }, [announcement]);

  return (
    <span aria-atomic="true" aria-live="polite" className="sr-only" role="status">
      {published}
    </span>
  );
}

export interface ActivityDockProps {
  readonly snapshot: ActivitySnapshot;
  readonly compact: boolean;
  /** Show the button before any record exists, for sections the provider reports. */
  readonly alwaysVisible?: boolean;
  readonly avoidRightPanelSheet?: boolean;
  readonly onOpenSection: (section: ActivitySection) => void;
}

export function ActivityDock({
  snapshot,
  compact,
  alwaysVisible = false,
  avoidRightPanelSheet = false,
  onOpenSection,
}: ActivityDockProps) {
  const viewModel = normalizeActivityDockSnapshot(snapshot, alwaysVisible);
  if (viewModel === null || !viewModel.visibility.visible) {
    return null;
  }
  const visibility = viewModel.visibility;
  const subagents = summarizeSection(
    visibility.showSubagents,
    viewModel.counts.subagents,
    viewModel.sections.subagents,
    viewModel.actors,
  );
  const backgroundTasks = summarizeSection(
    visibility.showBackgroundTasks,
    viewModel.counts.backgroundTasks,
    viewModel.sections.backgroundTasks,
    viewModel.workItems,
  );
  const active = addCounts(subagents.active, backgroundTasks.active);
  const done = addCounts(subagents.done, backgroundTasks.done);
  const dataIsStale =
    viewModel.observationState === "reconnecting" || viewModel.observationState === "stale";
  // Errors win over stale, whether one section or the whole observation degraded.
  const status: DegradedState | null =
    viewModel.observationState === "error" ||
    subagents.state === "error" ||
    backgroundTasks.state === "error"
      ? "error"
      : dataIsStale || subagents.state === "stale" || backgroundTasks.state === "stale"
        ? "stale"
        : null;
  const accessibleCounts = [
    ...(visibility.showSubagents
      ? [
          countLabel(subagents.active, "active subagent"),
          countLabel(subagents.done, "done subagent"),
        ]
      : []),
    ...(visibility.showBackgroundTasks
      ? [
          countLabel(backgroundTasks.active, "active background task"),
          countLabel(backgroundTasks.done, "done background task"),
        ]
      : []),
  ].join(", ");
  const liveAnnouncement = `Activity update: ${accessibleCounts}${
    dataIsStale ? ". Activity data stale" : ""
  }${subagents.state === null ? "" : `. Subagents ${subagents.state}`}${
    backgroundTasks.state === null ? "" : `. Background tasks ${backgroundTasks.state}`
  }`;
  const breakdown = `${[
    ...(visibility.showSubagents
      ? [`Subagents ${subagents.active} active, ${subagents.done} done`]
      : []),
    ...(visibility.showBackgroundTasks
      ? [`Background tasks ${backgroundTasks.active} active, ${backgroundTasks.done} done`]
      : []),
  ].join("; ")}${status === null ? "" : `. Status: ${status}`}`;
  const idle = active === 0 && done === 0;

  return (
    <div
      className={cn(
        "pointer-events-none absolute top-3 z-20",
        avoidRightPanelSheet ? ACTIVITY_DOCK_SHEET_INSET_CLASS_NAME : "right-3",
      )}
      data-testid="activity-dock"
    >
      <div className="pointer-events-auto w-fit max-w-72 rounded-lg border border-border bg-popover text-popover-foreground shadow-md">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label={`Open Activity: ${breakdown}`}
                className="h-9 min-h-9 w-full min-w-9 gap-2 px-2"
                onClick={() => onOpenSection(sectionToOpen(visibility, subagents, backgroundTasks))}
                size="sm"
                variant="ghost"
              >
                <span
                  aria-hidden="true"
                  className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-muted"
                  data-activity-provider-glyph={viewModel.provider}
                >
                  {renderProviderIcon(viewModel.provider, "size-3")}
                </span>
                <DegradedStatus state={status} />
                {idle ? (
                  <span
                    aria-hidden="true"
                    className="whitespace-nowrap text-xs text-muted-foreground"
                    data-activity-idle="true"
                  >
                    Activity
                  </span>
                ) : (
                  <>
                    <span
                      aria-hidden="true"
                      className="whitespace-nowrap text-xs tabular-nums"
                      data-activity-count="active"
                    >
                      Active {active}
                    </span>
                    {compact ? (
                      <span
                        aria-hidden="true"
                        className="text-base leading-none font-bold text-foreground"
                        data-activity-count-separator="true"
                      >
                        ·
                      </span>
                    ) : null}
                    <span
                      aria-hidden="true"
                      className="whitespace-nowrap text-xs text-muted-foreground tabular-nums"
                      data-activity-count="done"
                    >
                      Done {done}
                    </span>
                  </>
                )}
              </Button>
            }
          />
          <TooltipPopup side="bottom">{breakdown}</TooltipPopup>
        </Tooltip>
        <ActivityLiveAnnouncement announcement={liveAnnouncement} />
      </div>
    </div>
  );
}
