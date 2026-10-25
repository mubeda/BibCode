import { projectKey } from "@bibcode/client-runtime/state/entities";
import type { EnvironmentProject } from "@bibcode/client-runtime/state/shell";
import type { EnvironmentId, ScopedProjectRef } from "@bibcode/contracts";
import {
  Fragment,
  createContext,
  use,
  useCallback,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { usePrimarySettings } from "../../hooks/useSettings";
import { usePullRequestsStore } from "../../pullRequestsStore";
import { useProject, useServerConfigs } from "../../state/entities";
import { useEnvironmentConnectionState } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { worktreeEnvironment } from "../../state/worktrees";
import { GitHubIcon, GitLabIcon } from "../Icons";
import { PullRequestsContextRefresh } from "../pullRequests/pullRequestsContextRefresh";
import { usePullRequestsContextQuery } from "../pullRequests/usePullRequestsContextQuery";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import type {
  AvailableRepositoryContext,
  RepositoryModuleDescriptor,
  RepositoryModuleFirstPagePrefetch,
  RepositoryModuleView,
} from "./repositoryModuleDescriptor";
import {
  resolveRepositoryModuleAvailability,
  resolveRepositoryModuleMutationsDisabledReason,
  type RepositoryModuleAvailability,
} from "./repositoryModuleAvailability";
import { RepositoryModuleExternalLink } from "./RepositoryModuleExternalLink";
import { RepositoryModuleUnavailableState } from "./RepositoryModuleUnavailableState";

type ContextQuery = ReturnType<typeof usePullRequestsContextQuery>;

interface WorktreeOption {
  readonly value: string;
  readonly label: string;
}

/**
 * The shell's context: `state` is what the module shows, `actions` what it can ask
 * for, `meta` what it is. Only the Provider knows how any of it is resolved.
 */
export interface RepositoryModuleValue {
  readonly state: {
    readonly availability: RepositoryModuleAvailability<
      RepositoryModuleDescriptor["readsCapability"]
    >;
    readonly project: EnvironmentProject | null;
    readonly cwd: string | null;
    readonly scope: { readonly environmentId: EnvironmentId; readonly cwd: string };
    /** The repository context once available, live or stored. */
    readonly context: AvailableRepositoryContext | null;
    readonly contextQuery: ContextQuery["query"];
    readonly storedContext: boolean;
    readonly worktreeOptions: readonly WorktreeOption[];
    readonly worktreeStatus: string | null;
    /** The first page read alongside the context, until the list view takes it. */
    readonly freshPageKey: string | null;
  };
  readonly actions: {
    readonly rescan: () => void;
    readonly recover: () => void;
    readonly setCwd: (cwd: string) => void;
    readonly consumeFreshPage: (key: string) => void;
  };
  readonly meta: {
    readonly module: RepositoryModuleDescriptor;
    readonly projectRef: ScopedProjectRef;
    readonly mutationsDisabledReason: string | null;
  };
}

const RepositoryModuleContext = createContext<RepositoryModuleValue | null>(null);

function useRepositoryModuleValue(): RepositoryModuleValue {
  const value = use(RepositoryModuleContext);
  if (value === null) throw new Error("RepositoryModule parts render inside its Provider.");
  return value;
}

/** The shell's value with its context, for the parts `RepositoryModule.Gate` renders. */
export function useRepositoryModule(): RepositoryModuleValue & {
  readonly context: AvailableRepositoryContext;
} {
  const value = useRepositoryModuleValue();
  const context = value.state.context;
  if (context === null)
    throw new Error("RepositoryModule.Gate renders its children only with a context.");
  return { ...value, context };
}

/**
 * Resolves a module's shell for one project: availability, checkout, worktrees,
 * repository context and the early first page. The module's root component calls
 * it and hands the value to `RepositoryModule.Provider`; this hook is the only
 * place that knows how any of it is read.
 */
export function useRepositoryModuleShell({
  projectRef,
  module,
  view,
  firstPagePrefetch,
}: {
  projectRef: ScopedProjectRef;
  module: RepositoryModuleDescriptor;
  view: RepositoryModuleView;
  firstPagePrefetch: RepositoryModuleFirstPagePrefetch;
}): RepositoryModuleValue {
  const { environmentId, projectId } = projectRef;
  const stableProjectRef = useMemo(
    () => ({ environmentId, projectId }),
    [environmentId, projectId],
  );
  const project = useProject(stableProjectRef);
  const connection = useEnvironmentConnectionState(environmentId);
  const serverConfig = useServerConfigs().get(environmentId) ?? null;
  const enabled = usePrimarySettings((settings) => settings[module.settingKey]);
  const connectionState = connection.data;
  const availability = useMemo(
    () => resolveRepositoryModuleAvailability(module, connectionState, serverConfig, enabled),
    [connectionState, enabled, module, serverConfig],
  );
  const ready = availability.kind === "ready";
  const storeKey = projectKey(stableProjectRef);
  // One checkout per project, shared by every repository module.
  const storedCwd = usePullRequestsStore(
    (state) => state.byProjectKey[storeKey]?.checkoutCwd ?? null,
  );
  const cwd = storedCwd ?? project?.workspaceRoot ?? null;
  const catalogProjectId = project?.id ?? null;
  const catalogAtom = useMemo(
    () =>
      ready && catalogProjectId !== null
        ? worktreeEnvironment.catalog({ environmentId, input: { projectId: catalogProjectId } })
        : null,
    [ready, catalogProjectId, environmentId],
  );
  const catalog = useEnvironmentQuery(catalogAtom);
  const {
    contextAtom,
    query,
    storedContext,
    rescan: rescanContext,
    recover,
  } = usePullRequestsContextQuery({
    environmentId,
    cwd,
    enabled: ready && catalogProjectId !== null,
  });
  const contextPending = query.data === null && query.error === null;
  // The list's default first page does not depend on the context, so it loads
  // alongside it. The shell reads it only while the context is pending.
  const prefetching = contextAtom !== null && contextPending && view === "list";
  const firstPage = useMemo(
    () => (prefetching && cwd !== null ? firstPagePrefetch(cwd) : null),
    [cwd, firstPagePrefetch, prefetching],
  );
  useEnvironmentQuery(firstPage?.atom ?? null);
  const prefetchKey = firstPage?.key ?? null;
  // Retain the last prefetch through the context transition before children render.
  // React can replay this guarded adjustment; only the committed list consumes it.
  const [freshPage, setFreshPage] = useState(() => ({ prefetchKey, key: prefetchKey }));
  const discardFreshPage =
    query.error !== null || query.data?.status === "unavailable" || view !== "list";
  if (freshPage.prefetchKey !== prefetchKey || (discardFreshPage && freshPage.key !== null)) {
    setFreshPage({
      prefetchKey,
      key: discardFreshPage ? null : (prefetchKey ?? freshPage.key),
    });
  }
  const consumeFreshPage = useCallback((key: string) => {
    setFreshPage((current) => (current.key === key ? { ...current, key: null } : current));
  }, []);
  const scope = useMemo(() => ({ environmentId, cwd: cwd ?? "" }), [environmentId, cwd]);
  const workspaceRoot = project?.workspaceRoot;
  const worktreeOptions = useMemo(() => {
    const options: WorktreeOption[] = workspaceRoot
      ? [{ value: workspaceRoot, label: "Main checkout" }]
      : [];
    for (const worktree of catalog.data?.worktrees ?? []) {
      if (worktree.path === workspaceRoot || worktree.isBare) continue;
      options.push({ value: worktree.path, label: worktree.branch ?? worktree.path });
    }
    if (cwd !== null && !options.some((option) => option.value === cwd))
      options.push({ value: cwd, label: cwd });
    return options;
  }, [catalog.data, cwd, workspaceRoot]);
  const refreshCatalog = catalog.refresh;
  const rescan = useCallback(() => {
    rescanContext();
    refreshCatalog();
  }, [refreshCatalog, rescanContext]);
  const setCwd = useCallback(
    (value: string) => usePullRequestsStore.getState().setCheckoutCwd(stableProjectRef, value),
    [stableProjectRef],
  );
  const worktreeStatus =
    catalog.error ?? (catalog.isPending && catalog.data === null ? "Loading worktrees…" : null);
  const context = query.data?.status === "available" ? query.data : null;
  const mutationsDisabledReason = resolveRepositoryModuleMutationsDisabledReason(
    module,
    serverConfig,
  );
  const value = useMemo<RepositoryModuleValue>(
    () => ({
      state: {
        availability,
        project,
        cwd,
        scope,
        context,
        contextQuery: query,
        storedContext,
        worktreeOptions,
        worktreeStatus,
        freshPageKey: freshPage.key,
      },
      actions: { rescan, recover, setCwd, consumeFreshPage },
      meta: { module, projectRef: stableProjectRef, mutationsDisabledReason },
    }),
    [
      availability,
      consumeFreshPage,
      context,
      cwd,
      freshPage.key,
      module,
      mutationsDisabledReason,
      project,
      query,
      recover,
      rescan,
      scope,
      setCwd,
      stableProjectRef,
      storedContext,
      worktreeOptions,
      worktreeStatus,
    ],
  );
  return value;
}

/** Hands the module's shell to its parts; `value` comes from `useRepositoryModuleShell`. */
function Provider({ value, children }: { value: RepositoryModuleValue; children: ReactNode }) {
  return <RepositoryModuleContext value={value}>{children}</RepositoryModuleContext>;
}

/** The checkout the module reads, chosen among the project's worktrees. */
function WorktreeSelect() {
  const {
    state: { worktreeOptions, cwd, worktreeStatus },
    actions: { setCwd },
    meta: { module },
  } = useRepositoryModuleValue();
  const statusId = `${module.id}-worktree-status`;
  return (
    <div className="w-48">
      <Select
        modal={false}
        items={worktreeOptions}
        value={cwd}
        onValueChange={(value) => {
          if (value !== null) setCwd(value);
        }}
      >
        <SelectTrigger
          aria-label="Worktree"
          aria-describedby={worktreeStatus ? statusId : undefined}
          size="sm"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {worktreeOptions.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              <span className="flex flex-col">
                <span>{option.label}</span>
                <span className="text-xs text-muted-foreground">{option.value}</span>
              </span>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {worktreeStatus ? (
        <p id={statusId} className="text-xs text-muted-foreground">
          {worktreeStatus}
        </p>
      ) : null}
    </div>
  );
}

function availabilityReason(
  module: RepositoryModuleDescriptor,
  availability: Exclude<RepositoryModuleValue["state"]["availability"], { kind: "ready" }>,
): string {
  switch (availability.kind) {
    case "disabled_in_settings":
      return module.disabledMessage;
    case "unsupported":
      return module.unsupportedMessage;
    case "pending":
    case "disconnected":
      return availability.reason;
  }
}

/**
 * Renders its children only once the module can show its views, and otherwise the
 * one state that explains why: turned off, unsupported, disconnected, waiting,
 * signed out, unreachable, or a provider the module does not show yet. Children
 * remount when the checkout, provider, host, repository or account changes, so no
 * dialog or old view crosses scopes.
 */
function Gate({ children }: { children: ReactNode }) {
  const {
    state: { availability, project, cwd, context, contextQuery: query, storedContext },
    actions: { rescan, recover },
    meta: { module, projectRef },
  } = useRepositoryModuleValue();
  const unavailable = (props: {
    reason: string;
    disabledInSettings?: boolean;
    authCommand?: string | null;
    installHint?: string | null;
    onRescan?: () => void;
    isPending?: boolean;
    children?: ReactNode;
  }) => <RepositoryModuleUnavailableState label={module.label} Icon={module.Icon} {...props} />;
  if (availability.kind !== "ready")
    return unavailable({
      reason: availabilityReason(module, availability),
      disabledInSettings: availability.kind === "disabled_in_settings",
    });
  if (!project || cwd === null) return unavailable({ reason: "Waiting for project data." });
  if ((query.error !== null && !storedContext) || query.data?.status === "unavailable") {
    const answer = query.data?.status === "unavailable" ? query.data : null;
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col">
        <div className="border-b border-panel-separator p-3">
          <WorktreeSelect />
        </div>
        {unavailable({
          reason: query.error ?? answer?.message ?? "",
          authCommand: answer?.authCommand ?? null,
          installHint: answer?.installHint ?? null,
          onRescan: rescan,
          isPending: query.isPending,
        })}
      </div>
    );
  }
  if (context === null)
    return (
      <div role="status" className="space-y-3 p-4">
        <span className="sr-only">Loading {module.label}…</span>
        <Skeleton className="h-8 w-60" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    );
  const gap = module.providerGap(context);
  if (gap !== null)
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col">
        <div className="border-b border-panel-separator p-3">
          <WorktreeSelect />
        </div>
        {unavailable({
          reason: gap.message,
          children: (
            <p className="text-sm">
              <RepositoryModuleExternalLink href={gap.url}>
                {gap.linkLabel}
              </RepositoryModuleExternalLink>
            </p>
          ),
        })}
      </div>
    );
  return (
    <PullRequestsContextRefresh value={recover}>
      <Fragment
        key={JSON.stringify([
          projectKey(projectRef),
          cwd,
          context.provider,
          context.host,
          context.repository,
          context.account.login,
        ])}
      >
        {children}
      </Fragment>
    </PullRequestsContextRefresh>
  );
}

/** The module's header bar: identity, checkout and the module's own actions. */
function Header({ children }: { children: ReactNode }) {
  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-panel-separator px-4 py-3">
      {children}
    </header>
  );
}

/** The provider, repository, custom host and signed-in account the module reads. */
function Identity() {
  const { context } = useRepositoryModule();
  const Icon = context.provider === "github" ? GitHubIcon : GitLabIcon;
  const customHost = context.host !== "github.com" && context.host !== "gitlab.com";
  return (
    <>
      <Icon aria-hidden="true" className="size-5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{context.repository}</p>
        <p className="text-xs text-muted-foreground">
          {customHost ? `${context.host} · ` : ""}
          {context.account.login}
        </p>
      </div>
    </>
  );
}

/**
 * The shell both repository modules (Pull Requests, Pipelines) are built on:
 * availability, checkout, repository context and their states live here once.
 */
export const RepositoryModule = { Provider, Gate, Header, Identity, WorktreeSelect };
