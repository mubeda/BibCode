import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ServerProviderUsageProvider,
  ServerProviderUsageResult,
} from "@bibcode/contracts";
import type {
  ClientSettings,
  StatusBarUsageMode,
  UsagePercentageDisplay,
} from "@bibcode/contracts/settings";
import { useNavigate } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { RefreshCwIcon } from "lucide-react";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { useHasSlowRpcAckRequests } from "../../rpc/requestLatencyState";
import { useActiveEnvironmentId } from "../../state/entities";
import { useEnvironment, usePrimaryLocalEnvironmentForSelected } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useKnownTerminalSessions } from "../../state/terminalSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderUsageControl } from "./ProviderUsageControl";
import { McpAgentIndicator } from "./McpAgentIndicator";
import { ProfilerRecordingSegment } from "./ProfilerRecordingSegment";
import { ResourceUsageSegment } from "./ResourceUsageSegment";
import { SlowRequestsIndicator } from "./SlowRequestsIndicator";
import {
  environmentNotConnectedReason,
  type ResourceDiagnosticsQueryState,
} from "./statusBarPresentation";
import {
  antigravityPlaceholderViewModel,
  NOT_FETCHED_MESSAGE,
  buildProviderUsageViewModels,
  providerUsageRelativeLabelKey,
  type AntigravityPlaceholder,
  type ProviderUsageViewModel,
} from "./providerUsagePresentation";

export const STATUS_BAR_USAGE_REFRESH_INTERVAL_MS = 30_000;
export const STATUS_BAR_RESOURCE_REFRESH_INTERVAL_MS = 2_000;
export const STATUS_BAR_USAGE_ICON_ONLY_BREAKPOINT_PX = 820;

// The bar's own look, shared by the full status bar and the hosted app's slow-request bar.
const STATUS_BAR_CLASS_NAME =
  "relative z-20 flex h-6 min-h-6 shrink-0 items-center gap-3 border-t border-panel-separator bg-background px-3 text-xs";

type StatusBarUsageRefresh = () => void | Promise<unknown>;
type ProviderUsageQueryEmission = AsyncResult.AsyncResult<ServerProviderUsageResult, unknown>;

interface ProviderUsageResetOverlay {
  readonly usage: ServerProviderUsageResult;
  readonly queryEmission: ProviderUsageQueryEmission;
}

interface ProviderUsagePresentation {
  readonly snapshots: ServerProviderUsageResult["providers"];
  readonly percentageDisplay: UsagePercentageDisplay;
  readonly showClaudeUsage: boolean;
  readonly showCodexUsage: boolean;
  readonly showAntigravityUsage: boolean;
  readonly antigravityPlaceholder: AntigravityPlaceholder | null;
  readonly relativeLabelKey: string;
  readonly providers: ReadonlyArray<ProviderUsageViewModel>;
}

interface StatusBarClientSettings {
  readonly showClaudeUsage: boolean;
  readonly showCodexUsage: boolean;
  readonly showAntigravityUsage: boolean;
  readonly showResourceUsage: boolean;
  readonly statusBarUsageMode: StatusBarUsageMode;
  readonly usagePercentageDisplay: UsagePercentageDisplay;
}

const EMPTY_PROVIDER_USAGE_CACHE_ATOM = Atom.make<ProviderUsageResetOverlay | null>(null);
const providerUsageResetCacheAtom = Atom.family((_environmentId: EnvironmentId) =>
  Atom.make<ProviderUsageResetOverlay | null>(null),
);

const selectStatusBarClientSettings = (settings: ClientSettings): StatusBarClientSettings => ({
  showClaudeUsage: settings.statusBarItems.includes("claude"),
  showCodexUsage: settings.statusBarItems.includes("codex"),
  showAntigravityUsage: settings.showAntigravityUsage,
  showResourceUsage: settings.statusBarItems.includes("resource-usage"),
  statusBarUsageMode: settings.statusBarUsageMode,
  usagePercentageDisplay: settings.usagePercentageDisplay,
});
const equalStatusBarClientSettings = (
  previous: StatusBarClientSettings,
  next: StatusBarClientSettings,
): boolean =>
  previous.showClaudeUsage === next.showClaudeUsage &&
  previous.showCodexUsage === next.showCodexUsage &&
  previous.showAntigravityUsage === next.showAntigravityUsage &&
  previous.showResourceUsage === next.showResourceUsage &&
  previous.statusBarUsageMode === next.statusBarUsageMode &&
  previous.usagePercentageDisplay === next.usagePercentageDisplay;
const NOOP_OPEN_PROVIDER_SETTINGS = (): void => {};
// The clock has no subscription: the bar samples it whenever it renders, as each poll does.
const NOOP_CLOCK_SUBSCRIBE = (): (() => void) => () => {};
const EMPTY_PROVIDER_USAGE_SNAPSHOTS: ServerProviderUsageResult["providers"] = [];

function visibleProviderUsage(
  queried: ServerProviderUsageResult | null,
  queryEmission: ProviderUsageQueryEmission,
  reset: ProviderUsageResetOverlay | null,
): ServerProviderUsageResult | null {
  return reset !== null && isProviderUsageResetCurrent(reset, queryEmission)
    ? reset.usage
    : queried;
}

function buildProviderUsagePresentation(
  input: Omit<ProviderUsagePresentation, "providers">,
  presentationNow: DateTime.Utc | undefined,
): ProviderUsagePresentation {
  const derived = buildProviderUsageViewModels(input.snapshots, {
    now: presentationNow ?? DateTime.nowUnsafe(),
    percentageDisplay: input.percentageDisplay,
  });
  const byProvider = new Map(derived.map((provider) => [provider.provider, provider]));
  return {
    ...input,
    providers: (["claude", "codex", "antigravity"] as const).flatMap((provider) => {
      const visible = {
        claude: input.showClaudeUsage,
        codex: input.showCodexUsage,
        antigravity: input.showAntigravityUsage,
      }[provider];
      if (!visible) return [];
      const viewModel = byProvider.get(provider);
      if (viewModel !== undefined) return [viewModel];
      // Antigravity renders before its first answer, and on a server that cannot serve it.
      return provider === "antigravity" && input.antigravityPlaceholder !== null
        ? [antigravityPlaceholderViewModel(input.antigravityPlaceholder)]
        : [];
    }),
  };
}

function isProviderUsageResetCurrent(
  reset: ProviderUsageResetOverlay,
  emission: ProviderUsageQueryEmission,
): boolean {
  if (reset.queryEmission === emission) return true;
  // SWR waiting and failure-with-previous emissions are transitional: neither
  // is an authoritative replacement for the command result. A settled success
  // supersedes the overlay, while Initial/failure-without-previous invalidate it.
  return (
    (emission._tag === "Success" && emission.waiting) ||
    (emission._tag === "Failure" && Option.isSome(emission.previousSuccess))
  );
}

/** Only the user's forced refresh may clear an exhausted cut-off (`refresh`); timers revalidate. */
function rereadFor<Reread>({
  force,
  refresh,
  revalidate,
}: {
  readonly force: boolean;
  readonly refresh: Reread;
  readonly revalidate: Reread;
}): Reread {
  return force ? refresh : revalidate;
}

function runStatusBarUsageRefresh(refresh: StatusBarUsageRefresh): void {
  void Promise.resolve(refresh()).catch(() => {
    // Manual refresh already reports through the command layer; background refresh
    // should not create an unhandled rejection if the environment disconnects.
  });
}

/** The page whose focus and visibility gate the status bar's polling. */
export interface StatusBarWindowActivity {
  readonly window: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  readonly document: Pick<EventTarget, "addEventListener" | "removeEventListener"> &
    Pick<Document, "visibilityState" | "hasFocus">;
}

function pageWindowActivity(): StatusBarWindowActivity | null {
  return typeof window === "undefined" || typeof document === "undefined"
    ? null
    : { window, document };
}

/**
 * Refreshes now and then every `intervalMs` while the window is visible and focused. A
 * hidden or unfocused window polls nothing (#168); it refreshes once when it is used again.
 */
export function startStatusBarUsageAutoRefresh({
  refresh,
  intervalMs = STATUS_BAR_USAGE_REFRESH_INTERVAL_MS,
  activity = pageWindowActivity(),
}: {
  readonly refresh: StatusBarUsageRefresh;
  readonly intervalMs?: number;
  /** `null` polls regardless, where there is no page to watch. */
  readonly activity?: StatusBarWindowActivity | null;
}): () => void {
  const isActive = () =>
    activity === null ||
    (activity.document.visibilityState === "visible" && activity.document.hasFocus());
  let intervalId: ReturnType<typeof globalThis.setInterval> | null = null;
  const poll = () => {
    if (intervalId !== null) return;
    intervalId = globalThis.setInterval(() => {
      runStatusBarUsageRefresh(refresh);
    }, intervalMs);
  };
  const pause = () => {
    if (intervalId === null) return;
    globalThis.clearInterval(intervalId);
    intervalId = null;
  };
  // Every event rechecks both conditions: focus can return while the page is hidden.
  const follow = () => {
    if (!isActive()) {
      pause();
    } else if (intervalId === null) {
      runStatusBarUsageRefresh(refresh);
      poll();
    }
  };

  // One read even in a background window, so the bar is not empty when it is first seen.
  runStatusBarUsageRefresh(refresh);
  if (isActive()) poll();
  activity?.window.addEventListener("focus", follow);
  activity?.window.addEventListener("blur", follow);
  activity?.document.addEventListener("visibilitychange", follow);
  return () => {
    activity?.window.removeEventListener("focus", follow);
    activity?.window.removeEventListener("blur", follow);
    activity?.document.removeEventListener("visibilitychange", follow);
    pause();
  };
}

export function createStatusBarRefreshHandler(input: {
  readonly environmentId: EnvironmentId | null;
  readonly refreshProviderUsage: (value: {
    readonly environmentId: EnvironmentId;
    readonly input: {
      readonly providers: readonly ServerProviderUsageProvider[];
      readonly force: boolean;
    };
  }) => Promise<unknown>;
  readonly refreshUsageQuery: () => void;
  readonly refreshProcessDiagnostics: () => void;
  readonly refreshLocalProcessDiagnostics: (() => void) | null;
}) {
  return async (force: boolean) => {
    if (input.environmentId === null) return;
    const providerRefresh = input.refreshProviderUsage({
      environmentId: input.environmentId,
      input: { providers: ["claude", "codex"], force },
    });
    input.refreshProcessDiagnostics();
    input.refreshLocalProcessDiagnostics?.();
    try {
      await providerRefresh;
    } finally {
      // Read only after the native fetch commits its snapshots. Reading before
      // this await leaves provider usage one refresh cycle behind.
      input.refreshUsageQuery();
    }
  };
}

/**
 * Antigravity refreshes in its own request with its own completion: it can never delay or fail
 * the Claude and Codex request, and a slow Claude or Codex request never delays its re-read.
 */
export function createAntigravityUsageRefreshHandler(input: {
  readonly environmentId: EnvironmentId | null;
  readonly refreshProviderUsage: (value: {
    readonly environmentId: EnvironmentId;
    readonly input: {
      readonly providers: readonly ServerProviderUsageProvider[];
      readonly force: boolean;
    };
  }) => Promise<unknown>;
  readonly refreshQuery: () => void;
}) {
  return async (force: boolean) => {
    if (input.environmentId === null) return;
    try {
      await input.refreshProviderUsage({
        environmentId: input.environmentId,
        input: { providers: ["antigravity"], force },
      });
    } catch {
      // An old server rejects the provider; its read answers without an entry, which says so.
    } finally {
      input.refreshQuery();
    }
  };
}

/**
 * The one Refresh button serves every visible usage request. It spins while any of them runs and
 * is disabled only while all of them run, so a slow request never blocks refreshing the others.
 */
export function statusBarRefreshControl(
  requests: ReadonlyArray<{ readonly visible: boolean; readonly busy: boolean }>,
): { readonly busy: boolean; readonly disabled: boolean } {
  const visible = requests.filter((request) => request.visible);
  return {
    busy: visible.some((request) => request.busy),
    disabled: visible.length > 0 && visible.every((request) => request.busy),
  };
}

/** Joins the refresh already running for an environment, or starts one. */
function joinRefreshFlight(
  flights: Map<EnvironmentId, Promise<void>>,
  environmentId: EnvironmentId,
  start: () => Promise<void>,
): Promise<void> {
  const existing = flights.get(environmentId);
  if (existing !== undefined) return existing;
  const flight = start();
  flights.set(environmentId, flight);
  const finish = () => {
    if (flights.get(environmentId) === flight) flights.delete(environmentId);
  };
  void flight.then(finish, finish);
  return flight;
}

export function createStatusBarResourceRefreshHandler(input: {
  readonly environmentId: EnvironmentId | null;
  readonly refreshProcessDiagnostics: () => void;
  readonly refreshLocalProcessDiagnostics: (() => void) | null;
}) {
  return () => {
    if (input.environmentId === null) return;
    input.refreshProcessDiagnostics();
    input.refreshLocalProcessDiagnostics?.();
  };
}

export function AppStatusBarView({
  usage,
  antigravityUsage = null,
  antigravityUsageError = null,
  showAntigravityUsage = false,
  diagnostics,
  localDiagnostics,
  terminalCount,
  isRefreshing = false,
  isRefreshDisabled = isRefreshing,
  iconOnly = false,
  showClaudeUsage = true,
  showCodexUsage = true,
  showResourceUsage = true,
  statusBarUsageMode = "detailed",
  usagePercentageDisplay = "remaining",
  presentationNow,
  providerStateKey,
  onRefresh,
  onOpenProviderSettings = NOOP_OPEN_PROVIDER_SETTINGS,
  onConsumeCodexRateLimitReset,
}: {
  readonly usage: ServerProviderUsageResult | null;
  /** The answer to the Antigravity-only read; null until it arrives. */
  readonly antigravityUsage?: ServerProviderUsageResult | null;
  /** Why the Antigravity read failed, while it has no answer to show. */
  readonly antigravityUsageError?: string | null;
  readonly showAntigravityUsage?: boolean;
  readonly diagnostics: ResourceDiagnosticsQueryState;
  readonly localDiagnostics: ResourceDiagnosticsQueryState | null;
  readonly terminalCount: number;
  /** A usage request is running: the button spins. */
  readonly isRefreshing?: boolean;
  /** Every visible usage request is running: another click would do nothing. */
  readonly isRefreshDisabled?: boolean;
  readonly iconOnly?: boolean;
  readonly showClaudeUsage?: boolean;
  readonly showCodexUsage?: boolean;
  readonly showResourceUsage?: boolean;
  readonly statusBarUsageMode?: StatusBarUsageMode;
  readonly usagePercentageDisplay?: UsagePercentageDisplay;
  readonly presentationNow?: DateTime.Utc;
  readonly providerStateKey?: string;
  readonly onRefresh: () => void;
  readonly onOpenProviderSettings?: () => void;
  readonly onConsumeCodexRateLimitReset?: React.ComponentProps<
    typeof ProviderUsageControl
  >["onConsumeCodexRateLimitReset"];
}) {
  const baseSnapshots = usage?.providers ?? EMPTY_PROVIDER_USAGE_SNAPSHOTS;
  const answered =
    antigravityUsage?.providers.find((snapshot) => snapshot.provider === "antigravity") ?? null;
  // A failed read after the server's not-fetched answer has nothing to show but how to recover.
  const antigravitySnapshot =
    answered !== null && !(antigravityUsageError !== null && answered.error === NOT_FETCHED_MESSAGE)
      ? answered
      : null;
  // Stable identity: the presentation cache below compares it.
  const snapshots = useMemo(
    () => (antigravitySnapshot === null ? baseSnapshots : [...baseSnapshots, antigravitySnapshot]),
    [baseSnapshots, antigravitySnapshot],
  );
  // No entry in an answer that succeeded means a server that ignores the request for it.
  const antigravityPlaceholder: AntigravityPlaceholder | null =
    antigravitySnapshot !== null
      ? null
      : antigravityUsage !== null && answered === null
        ? "unsupported"
        : antigravityUsageError !== null
          ? "failed"
          : "loading";
  const readRelativeLabelKey = () =>
    providerUsageRelativeLabelKey(snapshots, presentationNow ?? DateTime.nowUnsafe());
  const relativeLabelKey = useSyncExternalStore(
    NOOP_CLOCK_SUBSCRIBE,
    readRelativeLabelKey,
    readRelativeLabelKey,
  );
  const presentationInput = {
    snapshots,
    percentageDisplay: usagePercentageDisplay,
    showClaudeUsage,
    showCodexUsage,
    showAntigravityUsage,
    antigravityPlaceholder,
    relativeLabelKey,
  };
  // Rederive only when an input or a countdown label bucket changes, not on every clock tick.
  const [cachedPresentation, setCachedPresentation] = useState(() =>
    buildProviderUsagePresentation(presentationInput, presentationNow),
  );
  let presentation = cachedPresentation;
  if (
    presentation.snapshots !== snapshots ||
    presentation.percentageDisplay !== usagePercentageDisplay ||
    presentation.showClaudeUsage !== showClaudeUsage ||
    presentation.showCodexUsage !== showCodexUsage ||
    presentation.showAntigravityUsage !== showAntigravityUsage ||
    presentation.antigravityPlaceholder !== antigravityPlaceholder ||
    presentation.relativeLabelKey !== relativeLabelKey
  ) {
    presentation = buildProviderUsagePresentation(presentationInput, presentationNow);
    setCachedPresentation(presentation);
  }
  const providers = presentation.providers;
  return (
    <div
      className={`${STATUS_BAR_CLASS_NAME} justify-between`}
      data-status-bar=""
      data-testid="app-status-bar"
    >
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
        {providers.map((viewModel) => (
          <ProviderUsageControl
            iconOnly={iconOnly}
            key={`${providerStateKey ?? "provider-usage"}:${viewModel.provider}`}
            statusBarUsageMode={statusBarUsageMode}
            viewModel={viewModel}
            onConsumeCodexRateLimitReset={onConsumeCodexRateLimitReset}
            onOpenProviderSettings={onOpenProviderSettings}
          />
        ))}
        {providers.length > 0 ? (
          <button
            aria-busy={isRefreshing}
            aria-label="Refresh provider usage"
            className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60"
            disabled={isRefreshDisabled}
            title={isRefreshing ? "Refreshing provider usage" : "Refresh provider usage"}
            type="button"
            onClick={onRefresh}
          >
            <RefreshCwIcon aria-hidden className={`size-3 ${isRefreshing ? "animate-spin" : ""}`} />
          </button>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <SlowRequestsIndicator />
        <McpAgentIndicator />
        <ProfilerRecordingSegment />
        {showResourceUsage ? (
          <ResourceUsageSegment
            diagnostics={diagnostics}
            localDiagnostics={localDiagnostics}
            terminalCount={terminalCount}
            iconOnly={iconOnly}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * The hosted web app's status bar. With no primary environment there is nothing else
 * to show, so it carries only the slow-request indicator and takes no space until a
 * request is slow. The element stays mounted while collapsed so the indicator's live
 * region can announce the first slow request.
 */
export function SlowRequestsStatusBar() {
  const hasSlowRequests = useHasSlowRpcAckRequests();
  return (
    <div
      className={`${STATUS_BAR_CLASS_NAME} justify-end data-collapsed:h-0 data-collapsed:min-h-0 data-collapsed:overflow-hidden data-collapsed:border-t-0`}
      data-collapsed={hasSlowRequests ? undefined : ""}
      data-status-bar=""
      data-testid="slow-requests-status-bar"
    >
      <SlowRequestsIndicator />
    </div>
  );
}

export function AppStatusBar() {
  const atomRegistry = useContext(RegistryContext);
  const navigate = useNavigate();
  const environmentId = useActiveEnvironmentId();
  // The bar reads only the selected environment; when that one is down, say so rather
  // than leave its readout silently empty.
  const notConnectedReason = environmentNotConnectedReason(useEnvironment(environmentId));
  const primaryLocalEnvironment = usePrimaryLocalEnvironmentForSelected(environmentId);
  const primaryLocalEnvironmentId = primaryLocalEnvironment?.environmentId ?? null;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const refreshRef = useRef<() => Promise<unknown>>(async () => undefined);
  const resourceRefreshRef = useRef<() => void>(() => undefined);
  const autoRefreshCleanupRef = useRef<(() => void) | null>(null);
  const autoRefreshEnvironmentRef = useRef<EnvironmentId | null>(null);
  const resourceAutoRefreshCleanupRef = useRef<(() => void) | null>(null);
  const resourceAutoRefreshEnvironmentRef = useRef<EnvironmentId | null>(null);
  const refreshFlightsRef = useRef(new Map<EnvironmentId, Promise<void>>());
  const manualRefreshPendingRef = useRef(new Set<EnvironmentId>());
  // Antigravity's request has its own flight and its own manual pending state.
  const antigravityFlightsRef = useRef(new Map<EnvironmentId, Promise<void>>());
  const antigravityManualPendingRef = useRef(new Set<EnvironmentId>());
  const antigravityRefreshRef = useRef<() => Promise<void>>(async () => undefined);
  const [iconOnly, setIconOnly] = useState(false);
  const [manualRefreshPending, setManualRefreshPending] = useState<ReadonlySet<EnvironmentId>>(
    () => new Set(),
  );
  const [antigravityManualPending, setAntigravityManualPending] = useState<
    ReadonlySet<EnvironmentId>
  >(() => new Set());
  const {
    showClaudeUsage,
    showCodexUsage,
    showAntigravityUsage,
    showResourceUsage,
    statusBarUsageMode,
    usagePercentageDisplay,
  } = useClientSettings(selectStatusBarClientSettings, equalStatusBarClientSettings);
  const usageAtom =
    environmentId === null ? null : serverEnvironment.providerUsage({ environmentId, input: {} });
  const usage = useEnvironmentQuery(usageAtom);
  const resetUsageAtom =
    environmentId === null
      ? EMPTY_PROVIDER_USAGE_CACHE_ATOM
      : providerUsageResetCacheAtom(environmentId);
  const resetUsage = useAtomValue(resetUsageAtom);
  const diagnostics = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.processDiagnostics({ environmentId, input: {} }),
  );
  const localDiagnostics = useEnvironmentQuery(
    primaryLocalEnvironmentId === null
      ? null
      : serverEnvironment.processDiagnostics({
          environmentId: primaryLocalEnvironmentId,
          input: {},
        }),
  );
  // Antigravity is named in its own read, so a server only answers for it when asked.
  const antigravityUsage = useEnvironmentQuery(
    environmentId === null || !showAntigravityUsage
      ? null
      : serverEnvironment.providerUsage({
          environmentId,
          input: { providers: ["antigravity"] },
        }),
  );
  const terminalSessions = useKnownTerminalSessions({ environmentId, threadId: null });
  const refreshProviderUsage = useAtomCommand(serverEnvironment.refreshProviderUsage, {
    reportFailure: false,
  });
  const consumeCodexRateLimitReset = useAtomCommand(serverEnvironment.consumeCodexRateLimitReset, {
    reportFailure: false,
  });
  const performRefresh = useCallback(
    (force: boolean) =>
      createStatusBarRefreshHandler({
        environmentId,
        refreshProviderUsage,
        refreshUsageQuery: rereadFor({
          force,
          refresh: usage.refresh,
          revalidate: usage.revalidate,
        }),
        refreshProcessDiagnostics: rereadFor({
          force,
          refresh: diagnostics.refresh,
          revalidate: diagnostics.revalidate,
        }),
        refreshLocalProcessDiagnostics:
          primaryLocalEnvironmentId === null
            ? null
            : rereadFor({
                force,
                refresh: localDiagnostics.refresh,
                revalidate: localDiagnostics.revalidate,
              }),
      })(force),
    [
      diagnostics.refresh,
      diagnostics.revalidate,
      environmentId,
      localDiagnostics.refresh,
      localDiagnostics.revalidate,
      primaryLocalEnvironmentId,
      refreshProviderUsage,
      usage.refresh,
      usage.revalidate,
    ],
  );
  const performAntigravityRefresh = useCallback(
    (force: boolean) =>
      createAntigravityUsageRefreshHandler({
        environmentId,
        refreshProviderUsage,
        refreshQuery: rereadFor({
          force,
          refresh: antigravityUsage.refresh,
          revalidate: antigravityUsage.revalidate,
        }),
      })(force),
    [antigravityUsage.refresh, antigravityUsage.revalidate, environmentId, refreshProviderUsage],
  );
  // A server whose answer has no Antigravity entry cannot serve it: automatic refreshes stop
  // asking, and only the user's Refresh checks again (after a server upgrade, say).
  const antigravityServed =
    antigravityUsage.data === null ||
    antigravityUsage.data.providers.some((snapshot) => snapshot.provider === "antigravity");
  const refreshAntigravity = useCallback((): Promise<void> => {
    if (environmentId === null || !showAntigravityUsage || !antigravityServed) {
      return Promise.resolve();
    }
    return joinRefreshFlight(antigravityFlightsRef.current, environmentId, () =>
      performAntigravityRefresh(false),
    );
  }, [antigravityServed, environmentId, performAntigravityRefresh, showAntigravityUsage]);
  const refresh = useCallback((): Promise<void> => {
    if (environmentId === null) return Promise.resolve();
    return joinRefreshFlight(refreshFlightsRef.current, environmentId, () => performRefresh(false));
  }, [environmentId, performRefresh]);
  const handleRefresh = useCallback(() => {
    if (environmentId === null) return;
    if (showAntigravityUsage && !antigravityManualPendingRef.current.has(environmentId)) {
      antigravityManualPendingRef.current.add(environmentId);
      setAntigravityManualPending(new Set(antigravityManualPendingRef.current));
      const finishAntigravity = () => {
        if (!antigravityManualPendingRef.current.delete(environmentId)) return;
        setAntigravityManualPending(new Set(antigravityManualPendingRef.current));
      };
      void performAntigravityRefresh(true).then(finishAntigravity, finishAntigravity);
    }
    if (manualRefreshPendingRef.current.has(environmentId)) return;

    manualRefreshPendingRef.current.add(environmentId);
    setManualRefreshPending(new Set(manualRefreshPendingRef.current));
    const flight = performRefresh(true);
    const finish = () => {
      if (!manualRefreshPendingRef.current.delete(environmentId)) return;
      setManualRefreshPending(new Set(manualRefreshPendingRef.current));
    };
    void flight.then(finish, finish);
  }, [environmentId, performAntigravityRefresh, performRefresh, showAntigravityUsage]);
  const resourceRefresh = useMemo(
    () =>
      createStatusBarResourceRefreshHandler({
        environmentId,
        refreshProcessDiagnostics: diagnostics.revalidate,
        refreshLocalProcessDiagnostics:
          primaryLocalEnvironmentId === null ? null : localDiagnostics.revalidate,
      }),
    [diagnostics.revalidate, environmentId, localDiagnostics.revalidate, primaryLocalEnvironmentId],
  );
  const handleOpenProviderSettings = useCallback(() => {
    void navigate({ to: "/settings/providers" });
  }, [navigate]);
  const handleConsumeCodexRateLimitReset = useCallback(
    async (requestId: string) => {
      if (environmentId === null) {
        throw new Error("No environment is selected.");
      }
      const result = await consumeCodexRateLimitReset({
        environmentId,
        input: { requestId },
      });
      if (result._tag === "Success") {
        // Bind the response to the exact query emission current when the
        // command completed. Any emission observed during redemption is older
        // than this result; only a subsequent emission may supersede it.
        const queryEmission = usageAtom === null ? usage.emission : atomRegistry.get(usageAtom);
        atomRegistry.set(providerUsageResetCacheAtom(environmentId), {
          usage: result.value.usage,
          queryEmission,
        });
      }
      return result;
    },
    [atomRegistry, consumeCodexRateLimitReset, environmentId, usage.emission, usageAtom],
  );

  useEffect(() => {
    refreshRef.current = refresh;
    antigravityRefreshRef.current = refreshAntigravity;
  }, [refresh, refreshAntigravity]);

  useEffect(() => {
    resourceRefreshRef.current = resourceRefresh;
  }, [resourceRefresh]);

  useEffect(
    () => () => {
      autoRefreshCleanupRef.current?.();
      autoRefreshCleanupRef.current = null;
      autoRefreshEnvironmentRef.current = null;
      resourceAutoRefreshCleanupRef.current?.();
      resourceAutoRefreshCleanupRef.current = null;
      resourceAutoRefreshEnvironmentRef.current = null;
      refreshFlightsRef.current.clear();
      manualRefreshPendingRef.current.clear();
      antigravityFlightsRef.current.clear();
      antigravityManualPendingRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    if (environmentId === null) {
      autoRefreshCleanupRef.current?.();
      autoRefreshCleanupRef.current = null;
      autoRefreshEnvironmentRef.current = null;
      return;
    }
    if (usage.data === null || autoRefreshEnvironmentRef.current === environmentId) return;
    autoRefreshCleanupRef.current?.();
    autoRefreshEnvironmentRef.current = environmentId;
    autoRefreshCleanupRef.current = startStatusBarUsageAutoRefresh({
      refresh: () => refreshRef.current(),
    });
  }, [environmentId, usage.data]);

  useEffect(() => {
    if (environmentId === null) {
      resourceAutoRefreshCleanupRef.current?.();
      resourceAutoRefreshCleanupRef.current = null;
      resourceAutoRefreshEnvironmentRef.current = null;
      return;
    }
    if (resourceAutoRefreshEnvironmentRef.current === environmentId) return;
    resourceAutoRefreshCleanupRef.current?.();
    resourceAutoRefreshEnvironmentRef.current = environmentId;
    resourceAutoRefreshCleanupRef.current = startStatusBarUsageAutoRefresh({
      refresh: () => resourceRefreshRef.current(),
      intervalMs: STATUS_BAR_RESOURCE_REFRESH_INTERVAL_MS,
    });
  }, [environmentId]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setIconOnly(
        (entry?.contentRect.width ?? element.clientWidth) <
          STATUS_BAR_USAGE_ICON_ONLY_BREAKPOINT_PX,
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (
      environmentId === null ||
      resetUsage === null ||
      isProviderUsageResetCurrent(resetUsage, usage.emission)
    ) {
      return;
    }
    if (atomRegistry.get(resetUsageAtom) === resetUsage) {
      atomRegistry.set(resetUsageAtom, null);
    }
  }, [atomRegistry, environmentId, resetUsage, resetUsageAtom, usage.emission]);

  // Antigravity polls on its own: turning it on reads it now, and neither a pending nor a failed
  // Claude and Codex read holds it back.
  useEffect(() => {
    if (environmentId === null || !showAntigravityUsage) return undefined;
    return startStatusBarUsageAutoRefresh({ refresh: () => antigravityRefreshRef.current() });
  }, [environmentId, showAntigravityUsage]);

  const refreshControl = statusBarRefreshControl([
    {
      visible: showClaudeUsage || showCodexUsage,
      busy: usage.isPending || (environmentId !== null && manualRefreshPending.has(environmentId)),
    },
    {
      visible: showAntigravityUsage,
      busy:
        antigravityUsage.isPending ||
        (environmentId !== null && antigravityManualPending.has(environmentId)),
    },
  ]);

  return (
    <div ref={containerRef}>
      <AppStatusBarView
        usage={visibleProviderUsage(usage.data, usage.emission, resetUsage)}
        diagnostics={{
          diagnostics: diagnostics.data,
          queryError: notConnectedReason ?? diagnostics.error,
        }}
        localDiagnostics={
          primaryLocalEnvironmentId === null
            ? null
            : {
                diagnostics: localDiagnostics.data,
                queryError: localDiagnostics.error,
              }
        }
        terminalCount={terminalSessions.length}
        isRefreshing={refreshControl.busy}
        isRefreshDisabled={refreshControl.disabled}
        iconOnly={iconOnly}
        showClaudeUsage={showClaudeUsage}
        showCodexUsage={showCodexUsage}
        showAntigravityUsage={showAntigravityUsage}
        antigravityUsage={showAntigravityUsage ? antigravityUsage.data : null}
        antigravityUsageError={showAntigravityUsage ? antigravityUsage.error : null}
        showResourceUsage={showResourceUsage}
        providerStateKey={environmentId ?? "no-environment"}
        statusBarUsageMode={statusBarUsageMode}
        usagePercentageDisplay={usagePercentageDisplay}
        onConsumeCodexRateLimitReset={
          environmentId === null ? undefined : handleConsumeCodexRateLimitReset
        }
        onOpenProviderSettings={handleOpenProviderSettings}
        onRefresh={handleRefresh}
      />
    </div>
  );
}
