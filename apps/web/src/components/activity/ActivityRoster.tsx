import {
  ACTIVITY_PAGE_MAX_LENGTH,
  type ActivityActorControl,
  type ActivityRecordId,
  type ActivityRecordSummary,
  type ActivitySection,
  type ActivitySnapshot,
} from "@bibcode/contracts";
import { BotIcon, ListTodoIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef, type ComponentType } from "react";

import { PROVIDER_ICON_BY_PROVIDER } from "~/components/chat/providerIconUtils";
import { Alert, AlertAction, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
  activityElapsedLabel,
  activityStatusLabel,
  compareActivityTimestamps,
  isActivityLifecycleActive,
} from "./activityPresentation";
import type { ActivityQueryResult, ActivityRosterPageData } from "./ActivityPanel";

const WINDOW_GROUP_SIZE = 50;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface ReconciledActivityRoster {
  readonly active: ReadonlyArray<ActivityRecordSummary>;
  readonly done: ReadonlyArray<ActivityRecordSummary>;
}

export function reconcileActivityRosterRecords(
  activeQuery: ActivityQueryResult<ActivityRosterPageData>,
  doneQuery: ActivityQueryResult<ActivityRosterPageData>,
  section: ActivitySection,
): ReconciledActivityRoster {
  const expectedTag = section === "subagents" ? "actor" : "workItem";
  const newestById = new Map<string, ActivityRecordSummary>();
  for (const query of [activeQuery, doneQuery]) {
    for (const page of query.pages) {
      for (const record of page.records) {
        if (record._tag !== expectedTag) {
          continue;
        }
        const current = newestById.get(record.id);
        if (current !== undefined) {
          const updateOrder = compareActivityTimestamps(record.updatedAt, current.updatedAt);
          if (updateOrder < 0) {
            continue;
          }
          if (updateOrder === 0) {
            const currentIsActive = isActivityLifecycleActive(current.status);
            const candidateIsActive = isActivityLifecycleActive(record.status);
            if (currentIsActive === candidateIsActive || candidateIsActive) {
              continue;
            }
          }
        }
        newestById.set(record.id, record);
      }
    }
  }
  const active: ActivityRecordSummary[] = [];
  const done: ActivityRecordSummary[] = [];
  for (const record of newestById.values()) {
    if (isActivityLifecycleActive(record.status)) {
      active.push(record);
    } else {
      done.push(record);
    }
  }
  active.sort(
    (left, right) =>
      compareActivityTimestamps(left.startedAt, right.startedAt) || compareText(left.id, right.id),
  );
  done.sort(
    (left, right) =>
      compareActivityTimestamps(
        right.terminalAt ?? right.updatedAt,
        left.terminalAt ?? left.updatedAt,
      ) || compareText(left.id, right.id),
  );

  const boundedActive = active.slice(0, ACTIVITY_PAGE_MAX_LENGTH);
  return {
    active: boundedActive,
    done: done.slice(0, Math.max(0, ACTIVITY_PAGE_MAX_LENGTH - boundedActive.length)),
  };
}

function queryHasSectionRecords(
  query: ActivityQueryResult<ActivityRosterPageData>,
  section: ActivitySection,
): boolean {
  const expectedTag = section === "subagents" ? "actor" : "workItem";
  for (const page of query.pages) {
    for (const record of page.records) {
      if (record._tag === expectedTag) {
        return true;
      }
    }
  }
  return false;
}

function RosterError({
  bucket,
  query,
  section,
  onRetry,
}: {
  readonly bucket: "active" | "done";
  readonly query: ActivityQueryResult<ActivityRosterPageData>;
  readonly section: ActivitySection;
  readonly onRetry: () => void;
}) {
  if (query.error === null) {
    return null;
  }
  const retained = queryHasSectionRecords(query, section);
  return (
    <Alert variant="error">
      <TriangleAlertIcon />
      <AlertDescription>
        {query.error}
        {retained ? " The last loaded page remains available." : ""}
      </AlertDescription>
      <AlertAction>
        <Button
          aria-label={`Retry ${bucket} activity`}
          onClick={onRetry}
          size="xs"
          variant="outline"
        >
          Retry
        </Button>
      </AlertAction>
    </Alert>
  );
}

function recordGroups(
  records: ReadonlyArray<ActivityRecordSummary>,
): ReadonlyArray<ReadonlyArray<ActivityRecordSummary>> {
  const groups: ActivityRecordSummary[][] = [];
  for (let index = 0; index < records.length; index += WINDOW_GROUP_SIZE) {
    groups.push(records.slice(index, index + WINDOW_GROUP_SIZE));
  }
  return groups;
}

function nextCursor(query: ActivityQueryResult<ActivityRosterPageData>): string | null {
  return query.pages.at(-1)?.nextCursor ?? null;
}

function providerForRecord(record: ActivityRecordSummary, fallback: string): string {
  return record._tag === "actor" ? (record.providerType ?? fallback) : fallback;
}

function providerIcon(provider: string): ComponentType<{ className?: string }> {
  if (!Object.hasOwn(PROVIDER_ICON_BY_PROVIDER, provider)) {
    return BotIcon;
  }
  const icon = PROVIDER_ICON_BY_PROVIDER[provider as keyof typeof PROVIDER_ICON_BY_PROVIDER];
  return typeof icon === "function" ? icon : BotIcon;
}

function recordTime(record: ActivityRecordSummary, now: string): string {
  if (isActivityLifecycleActive(record.status) || record.terminalAt === null) {
    return `Elapsed ${activityElapsedLabel(record.startedAt, now)}`;
  }
  return `Completed in ${activityElapsedLabel(record.startedAt, record.terminalAt)}`;
}

interface ActivityRecordRowProps {
  readonly record: ActivityRecordSummary;
  readonly control: ActivityActorControl | null;
  readonly provider: string;
  readonly now: string;
  readonly onSelect: (record: ActivityRecordSummary) => void;
  readonly onCancelActor?: (actorId: ActivityRecordId, controlRevision: number) => void;
  readonly registerRow: (recordId: string, element: HTMLButtonElement | null) => void;
}

function ActivityRecordRow({
  record,
  control,
  provider,
  now,
  onSelect,
  onCancelActor,
  registerRow,
}: ActivityRecordRowProps) {
  const recordProvider = providerForRecord(record, provider);
  const ProviderIcon = providerIcon(recordProvider);
  const RecordIcon = record._tag === "actor" ? BotIcon : ListTodoIcon;
  const typeLabel = record._tag === "actor" ? (record.role ?? "Actor") : record.workKind;
  const stopping = control?.state === "requested";
  const stopLabel =
    control === null || record._tag !== "actor"
      ? null
      : control.activeDescendantCount === 0
        ? `Stop ${record.name}`
        : `Stop ${record.name} and ${control.activeDescendantCount} child ${control.activeDescendantCount === 1 ? "agent" : "agents"}`;

  return (
    <div className="flex min-w-0 w-full items-start gap-1" data-activity-row-layout={record.id}>
      <Button
        className="min-w-0 flex-1 items-start justify-start gap-3 whitespace-normal px-3 py-2 text-left"
        data-activity-row={record.id}
        onClick={() => onSelect(record)}
        ref={(element) => registerRow(record.id, element)}
        size="content"
        variant="ghost"
      >
        <span className="mt-0.5 flex shrink-0 items-center -space-x-1">
          <span
            className="flex size-6 items-center justify-center rounded-full border border-border bg-muted"
            data-activity-provider-glyph={recordProvider}
            title={recordProvider}
          >
            <ProviderIcon aria-hidden="true" className="size-3.5" />
          </span>
          <span
            className="flex size-6 items-center justify-center rounded-full border border-border bg-background"
            data-activity-record-glyph={record._tag}
            title={typeLabel}
          >
            <RecordIcon aria-hidden="true" className="size-3.5" />
          </span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-medium">{record.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {stopping ? "Stopping" : activityStatusLabel(record.status)}
            </span>
          </span>
          {record.summary !== null ? (
            <span className="line-clamp-2 text-xs font-normal text-muted-foreground">
              {record.summary}
            </span>
          ) : null}
          <span className="mt-1 flex gap-2 text-[11px] font-normal text-muted-foreground">
            <span>{typeLabel}</span>
            <span>{recordTime(record, now)}</span>
          </span>
        </span>
      </Button>
      {stopLabel === null || control === null || onCancelActor === undefined ? null : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label={stopLabel}
                className="mt-1 shrink-0 text-muted-foreground hover:text-foreground"
                disabled={control.state === "requested"}
                onClick={(event) => {
                  event.stopPropagation();
                  onCancelActor(record.id, control.controlRevision);
                }}
                onPointerDown={(event) => event.stopPropagation()}
                size="icon-xs"
                variant="ghost"
              >
                <svg
                  aria-hidden="true"
                  fill="currentColor"
                  height="12"
                  viewBox="0 0 12 12"
                  width="12"
                >
                  <rect height="8" rx="1.5" width="8" x="2" y="2" />
                </svg>
              </Button>
            }
          />
          <TooltipPopup>{stopLabel}</TooltipPopup>
        </Tooltip>
      )}
    </div>
  );
}

export interface ActivityRosterProps {
  readonly section: ActivitySection;
  readonly snapshot: ActivitySnapshot;
  readonly active: ActivityQueryResult<ActivityRosterPageData>;
  readonly done: ActivityQueryResult<ActivityRosterPageData>;
  readonly reconciled: ReconciledActivityRoster;
  readonly now: string;
  readonly notification: string | null;
  readonly focusRecordId: string | null;
  readonly onFocusRestored: () => void;
  readonly onSelect: (record: ActivityRecordSummary) => void;
  readonly onLoadMore: (bucket: "active" | "done") => void;
  readonly onCancelActor?: (actorId: ActivityRecordId, controlRevision: number) => void;
}

export function ActivityRoster({
  section,
  snapshot,
  active,
  done,
  reconciled,
  now,
  notification,
  focusRecordId,
  onFocusRestored,
  onSelect,
  onLoadMore,
  onCancelActor,
}: ActivityRosterProps) {
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const activeRecords = reconciled.active;
  const doneRecords = reconciled.done;
  const totalCount = activeRecords.length + doneRecords.length;
  const sectionCounts = snapshot.counts[section];
  const sectionName = section === "subagents" ? "Subagents" : "Background Tasks";
  const emptyLabel =
    snapshot.sections[section].state === "unsupported"
      ? `${sectionName} are not supported by this provider.`
      : `No ${section === "subagents" ? "subagents" : "background tasks"} observed.`;
  const loadBucket =
    nextCursor(active) !== null ? "active" : nextCursor(done) !== null ? "done" : null;
  const loadingInitial =
    totalCount === 0 &&
    (active.loading || done.loading) &&
    snapshot.sections[section].state !== "unsupported";
  const hasRosterError = active.error !== null || done.error !== null;
  const actorControls = new Map<string, ActivityActorControl>(
    snapshot.control.actors.map((control) => [control.actorId, control]),
  );
  for (const query of [active, done]) {
    for (const page of query.pages) {
      for (const control of page.actorControls) {
        actorControls.set(control.actorId, control);
      }
    }
  }
  const controlForRecord = (record: ActivityRecordSummary): ActivityActorControl | null => {
    if (
      section !== "subagents" ||
      snapshot.scope._tag !== "thread" ||
      !snapshot.capabilities.targetedActorCancellation ||
      record._tag !== "actor" ||
      !isActivityLifecycleActive(record.status)
    ) {
      return null;
    }
    const control = actorControls.get(record.id);
    return control?.state === "available" || control?.state === "requested" ? control : null;
  };

  useEffect(() => {
    if (focusRecordId === null) {
      return;
    }
    const row = rowRefs.current.get(focusRecordId);
    if (row !== undefined) {
      row.focus();
      onFocusRestored();
    }
  }, [focusRecordId, onFocusRestored]);

  const registerRow = (recordId: string, element: HTMLButtonElement | null) => {
    if (element === null) {
      rowRefs.current.delete(recordId);
    } else {
      rowRefs.current.set(recordId, element);
    }
  };
  const activeGroups = recordGroups(activeRecords);
  const doneGroups = recordGroups(doneRecords);

  return (
    <section aria-label={sectionName} className="flex min-h-0 flex-1 flex-col">
      <header className="border-b border-border/60 px-3 py-2">
        <h2 className="font-medium">{sectionName}</h2>
      </header>
      {notification !== null ? (
        <p aria-live="polite" className="mx-3 mt-3 text-sm text-muted-foreground" role="status">
          {notification}
        </p>
      ) : null}
      <div className="space-y-3 p-2">
        <RosterError
          bucket="active"
          onRetry={() => onLoadMore("active")}
          query={active}
          section={section}
        />
        <RosterError
          bucket="done"
          onRetry={() => onLoadMore("done")}
          query={done}
          section={section}
        />
        {loadingInitial ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Spinner className="size-4" />
            Loading activity…
          </div>
        ) : totalCount === 0 && !hasRosterError ? (
          <p className="px-2 py-8 text-center text-sm text-muted-foreground">{emptyLabel}</p>
        ) : totalCount > 0 ? (
          <>
            <section aria-labelledby={`activity-${section}-active`}>
              <h3
                className="px-2 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground"
                id={`activity-${section}-active`}
              >
                Active
              </h3>
              <div>
                {activeGroups.map((group, groupIndex) => (
                  <div data-activity-window-group={`active-${groupIndex}`} key={group[0]?.id}>
                    {group.map((record) => (
                      <ActivityRecordRow
                        control={controlForRecord(record)}
                        key={record.id}
                        now={now}
                        onSelect={onSelect}
                        {...(onCancelActor === undefined ? {} : { onCancelActor })}
                        provider={snapshot.provider}
                        record={record}
                        registerRow={registerRow}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </section>
            <section aria-labelledby={`activity-${section}-done`}>
              <h3
                className="px-2 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground"
                id={`activity-${section}-done`}
              >
                Done · {sectionCounts.done}
              </h3>
              <div>
                {doneGroups.map((group, groupIndex) => (
                  <div data-activity-window-group={`done-${groupIndex}`} key={group[0]?.id}>
                    {group.map((record) => (
                      <ActivityRecordRow
                        control={controlForRecord(record)}
                        key={record.id}
                        now={now}
                        onSelect={onSelect}
                        {...(onCancelActor === undefined ? {} : { onCancelActor })}
                        provider={snapshot.provider}
                        record={record}
                        registerRow={registerRow}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </section>
          </>
        ) : null}
        {loadBucket !== null ? (
          <Button
            aria-label={`Load more ${section === "subagents" ? "subagents" : "background tasks"}`}
            className="w-full"
            disabled={active.loading || done.loading}
            onClick={() => onLoadMore(loadBucket)}
            size="sm"
            variant="outline"
          >
            {active.loading || done.loading ? "Loading more…" : "Load more"}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
