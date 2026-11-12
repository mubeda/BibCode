import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { HostMetricsView } from "@bibcode/client-runtime/state/server";
import type { EnvironmentId } from "@bibcode/contracts";
import type { ClientSettings } from "@bibcode/contracts/settings";
import { type JSX, useCallback, useContext, useMemo, useState } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { useEnvironment } from "~/state/environments";
import { hostDashboardRequest } from "~/state/hostDashboard";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";

import { useDocumentVisible } from "../pullRequests/useDocumentVisible";
import { useRelativeTimeTick } from "../settings/settingsLayout";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { RetryButton } from "../ui/retry-button";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "../ui/sheet";
import { Skeleton } from "../ui/skeleton";
import {
  type HostDashboardValues,
  hostMetricsRecentBars,
  hostMetricsUptimeBars,
  presentHostDashboard,
  shouldSubscribeToHostMetrics,
} from "./hostDashboard.logic";
import { HostMetricBars } from "./HostMetricBars";

/** Mounted once in `AppRoot`, outside the router, so navigation comes in as a callback. */
export function HostDashboardCoordinator({
  onOpenRemoteServers,
}: {
  readonly onOpenRemoteServers: () => void;
}): JSX.Element | null {
  const registry = useContext(RegistryContext);
  const request = useAtomValue(hostDashboardRequest);
  const close = useCallback(() => registry.set(hostDashboardRequest, null), [registry]);
  const openRemoteServers = useCallback(() => {
    close();
    onOpenRemoteServers();
  }, [close, onOpenRemoteServers]);
  return request === null ? null : (
    <HostDashboardSheet
      key={request.environmentId}
      environmentId={request.environmentId}
      onClose={close}
      onOpenRemoteServers={openRemoteServers}
    />
  );
}

const selectTimestampFormat = (settings: ClientSettings) => settings.timestampFormat;

interface ShownViews {
  /** The latest view of any subscription. */
  readonly last: HostMetricsView | null;
  /** The view shown before the current subscription; a different server identity is a restart. */
  readonly baseline: HostMetricsView | null;
  /** When the client received the latest view, on its own clock. */
  readonly receivedAtMs: number | null;
}

const NO_VIEWS: ShownViews = { last: null, baseline: null, receivedAtMs: null };

export function HostDashboardSheet({
  environmentId,
  onClose,
  onOpenRemoteServers,
}: {
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
  readonly onOpenRemoteServers: () => void;
}) {
  const environment = useEnvironment(environmentId);
  const visible = useDocumentVisible();
  const timestampFormat = useClientSettings(selectTimestampFormat);
  const nowMs = useRelativeTimeTick();
  const connected = environment?.connection.phase === "connected";
  const capabilities = environment?.serverConfig?.environment.capabilities;
  const supported = capabilities === undefined ? null : capabilities.hostMetrics;
  const query = useEnvironmentQuery(
    shouldSubscribeToHostMetrics({ open: true, visible, connected, supported: supported === true })
      ? serverEnvironment.hostMetrics({ environmentId, input: {} })
      : null,
  );
  const view = query.data;

  // Derived from the stream during render (no effect): a disconnect keeps the last values,
  // and the view from before a resubscription is the baseline a restart is detected against.
  const [shown, setShown] = useState<ShownViews>(NO_VIEWS);
  // Receipt time on the 1 s tick (render stays pure), so staleness is measured to the second.
  if (view !== null && view !== shown.last) {
    setShown({ last: view, baseline: shown.baseline, receivedAtMs: nowMs });
  } else if (view === null && shown.baseline !== shown.last) {
    setShown({ ...shown, baseline: shown.last });
  }

  const presentation = presentHostDashboard({
    view,
    shownView: shown.baseline,
    connected,
    supported,
    failure: query.error,
    lastItemAtMs: shown.receivedAtMs,
    nowMs,
    timestampFormat,
  });
  const chartView = view ?? shown.baseline;

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetPopup side="right" className="max-w-lg" data-testid="host-dashboard">
        <SheetHeader>
          <SheetTitle>{environment?.label ?? "Host dashboard"}</SheetTitle>
          <SheetDescription>Host dashboard</SheetDescription>
        </SheetHeader>
        <SheetPanel>
          <div data-text-surface="popover" className="grid gap-5 text-sm">
            {presentation.notice === null ? null : (
              <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
                <span
                  className={cn(presentation.state === "error" && "text-destructive-foreground")}
                >
                  {presentation.notice}
                </span>
                {presentation.state === "error" ? (
                  <RetryButton retrying={query.isPending} onRetry={query.refresh} />
                ) : null}
                {presentation.state === "unsupported" ? (
                  <Button size="xs" variant="outline" onClick={onOpenRemoteServers}>
                    Open Remote Servers
                  </Button>
                ) : null}
              </div>
            )}
            {presentation.state === "unsupported" ? null : presentation.values === null ? (
              <HostDashboardSkeleton />
            ) : (
              <div
                className={cn("grid gap-6 transition-opacity", presentation.dimmed && "opacity-64")}
              >
                <HostDashboardValuesView
                  values={presentation.values}
                  view={chartView}
                  timestampFormat={timestampFormat}
                />
              </div>
            )}
          </div>
        </SheetPanel>
      </SheetPopup>
    </Sheet>
  );
}

function HostDashboardSkeleton() {
  return (
    <div className="grid gap-4" aria-label="Loading host metrics">
      <Skeleton className="h-8 w-24" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-6 w-48" />
      <Skeleton className="h-16 w-full" />
    </div>
  );
}

function SectionHeading({ children, aside }: { children: string; aside?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <h3 className="font-medium text-foreground text-sm">{children}</h3>
      {aside === undefined ? null : <span className="text-muted-foreground text-xs">{aside}</span>}
    </div>
  );
}

function HostDashboardValuesView({
  values,
  view,
  timestampFormat,
}: {
  readonly values: HostDashboardValues;
  readonly view: HostMetricsView | null;
  readonly timestampFormat: ClientSettings["timestampFormat"];
}) {
  const recent = view?.recent;
  const uptime = view?.uptime;
  const charts = useMemo(
    () => ({
      cpuRecent: hostMetricsRecentBars(recent ?? [], "cpu", timestampFormat),
      memoryRecent: hostMetricsRecentBars(recent ?? [], "memory", timestampFormat),
    }),
    [recent, timestampFormat],
  );
  const uptimeCharts = useMemo(
    () => ({
      cpu: hostMetricsUptimeBars(uptime ?? [], "cpu", timestampFormat),
      memory: hostMetricsUptimeBars(uptime ?? [], "memory", timestampFormat),
    }),
    [uptime, timestampFormat],
  );
  return (
    <>
      <section className="grid gap-2">
        <SectionHeading aside={values.cores}>CPU</SectionHeading>
        <p
          data-testid="host-dashboard-cpu"
          data-sampled-at={values.sampledAt ?? undefined}
          className="font-semibold text-2xl tabular-nums"
        >
          {values.cpu}
        </p>
        <HostMetricBars bars={charts.cpuRecent} label="CPU, last 15 minutes" />
      </section>
      <section className="grid gap-2">
        <SectionHeading>Memory</SectionHeading>
        <p data-testid="host-dashboard-memory" className="font-medium text-base tabular-nums">
          {values.memory}
        </p>
        <HostMetricBars bars={charts.memoryRecent} label="Memory, last 15 minutes" />
      </section>
      <section className="grid gap-2">
        <SectionHeading>Volumes</SectionHeading>
        {values.volumesPaused ? (
          <p className="text-muted-foreground text-xs">
            Volume sizes are paused: earlier reads have not answered yet.
          </p>
        ) : null}
        {values.volumes.length === 0 ? (
          <p className="text-muted-foreground text-xs">No volumes reported yet.</p>
        ) : (
          <ul className="grid gap-3">
            {values.volumes.map((volume) => (
              <li key={volume.key} data-testid="host-dashboard-volume" className="grid gap-1">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="truncate font-medium" title={volume.mountPoint}>
                    {volume.mountPoint}
                  </span>
                  {volume.name.length > 0 && volume.name !== volume.mountPoint ? (
                    <span className="truncate text-muted-foreground text-xs">{volume.name}</span>
                  ) : null}
                  {volume.badges.map((badge) => (
                    <Badge
                      key={badge}
                      size="sm"
                      variant={badge === "Not responding" ? "warning" : "outline"}
                    >
                      {badge}
                    </Badge>
                  ))}
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                  <div
                    className="h-full rounded-full bg-blue-500/70"
                    style={{ width: `${volume.usedPercent ?? 0}%` }}
                  />
                </div>
                <div className="flex justify-between gap-2 text-muted-foreground text-xs tabular-nums">
                  <span>{volume.usage ?? "Size unknown"}</span>
                  {volume.free === null ? null : <span>{volume.free}</span>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section data-testid="host-dashboard-since" className="grid gap-3">
        <SectionHeading>{values.since ?? "Since start"}</SectionHeading>
        {values.statistics.length === 0 ? null : (
          <table className="w-full text-left text-xs tabular-nums">
            <thead className="text-muted-foreground">
              <tr>
                <th scope="col" className="font-normal" />
                {values.statistics[0]!.figures.map((figure) => (
                  <th key={figure.label} scope="col" className="font-normal">
                    {figure.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {values.statistics.map((row) => (
                <tr key={row.label}>
                  <th scope="row" className="py-0.5 font-medium">
                    {row.label}
                  </th>
                  {row.figures.map((figure) => (
                    <td key={figure.label}>{figure.value}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="grid gap-1">
          <span className="text-muted-foreground text-xs">CPU</span>
          <HostMetricBars bars={uptimeCharts.cpu} label="CPU since start" />
        </div>
        <div className="grid gap-1">
          <span className="text-muted-foreground text-xs">Memory</span>
          <HostMetricBars bars={uptimeCharts.memory} label="Memory since start" />
        </div>
        <p className="text-muted-foreground text-xs">
          Each bar is an average, with its peak drawn lighter above it.
        </p>
      </section>
    </>
  );
}
