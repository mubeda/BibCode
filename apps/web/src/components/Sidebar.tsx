import { useAtomValue } from "@effect/atom-react";
import {
  parseScopedThreadKey,
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@bibcode/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@bibcode/client-runtime/state/runtime";
import type { ScopedProjectRef, ScopedThreadRef, WorktreeRemovalResult } from "@bibcode/contracts";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { FolderPlusIcon, SearchIcon, SettingsIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { APP_BASE_NAME, APP_STAGE_LABEL } from "../branding";
import { useOpenAddProjectCommandPalette } from "../commandPaletteContext";
import { isDesktopLocalConnectionTarget } from "../connection/desktopLocal";
import {
  createEnvironmentTreeProjector,
  type EnvironmentTreeEnvironmentInput,
  type EnvironmentTreePreferences,
  type EnvironmentTreeProjection,
  type EnvironmentTreeRow,
  type EnvironmentTreeStatus,
} from "../environmentTree";
import {
  toggleEnvironmentDisclosure,
  toggleProjectDisclosure,
  type EnvironmentNavigationProjectCandidate,
} from "../environmentNavigationStore";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useThreadActions } from "../hooks/useThreadActions";
import {
  resolveShortcutCommand,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../keybindings";
import { isTerminalFocused } from "../lib/terminalFocus";
import { readLocalApi } from "../localApi";
import { isModelPickerOpen } from "../modelPickerVisibility";
import {
  selectIsPinned,
  selectIsUnread,
  useSidebarWorkspaceMetaStore,
} from "../sidebarWorkspaceMetaStore";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useProjects, useThreadShells } from "../state/entities";
import { primaryServerConfigAtom, primaryServerKeybindingsAtom } from "../state/server";
import { environmentAvailabilityCommands, useEnvironmentShellSummary } from "../state/shell";
import { useEnvironmentThread } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { useThreadHasTerminalSurface } from "../terminalSurfaceState";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import type { Project, SidebarThreadSummary } from "../types";
import { useEnvironmentNavigationState } from "../useEnvironmentNavigationState";
import { useClientSettings } from "~/hooks/useSettings";
import {
  buildSidebarThreadContextMenuItems,
  getSidebarThreadIdsToPrewarm,
  resolveAdjacentThreadId,
  resolveProjectMainThread,
  resolveProjectStatusIndicator,
  resolveSidebarStageBadgeLabel,
  resolveThreadStatusPill,
  shouldClearThreadSelectionOnMouseDown,
} from "./Sidebar.logic";
import { CreateWorktreeDialog } from "./CreateWorktreeDialog";
import { EnvironmentTree, type EnvironmentTreeContextMenuRequest } from "./sidebar/EnvironmentTree";
import { SidebarProviderUpdatePill } from "./sidebar/SidebarProviderUpdatePill";
import { SidebarUpdatePill } from "./sidebar/SidebarUpdatePill";
import { Input } from "./ui/input";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from "./ui/sidebar";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { WorktreeRemovalDialog, type WorktreeRemovalTarget } from "./WorktreeRemovalDialog";

export function handleSidebarNavigationKeyDown(input: {
  readonly event: Pick<
    globalThis.KeyboardEvent,
    "defaultPrevented" | "repeat" | "preventDefault" | "stopPropagation"
  >;
  readonly resolveCommand: () => string | null;
  readonly orderedThreadKeys: readonly string[];
  readonly currentThreadKey: string | null;
  readonly jumpThreadKeys: readonly string[];
  readonly threadByKey: ReadonlyMap<string, SidebarThreadSummary>;
  readonly navigateToThread: (threadRef: ScopedThreadRef) => void;
}): boolean {
  if (input.event.defaultPrevented || input.event.repeat) return false;

  const command = input.resolveCommand();
  const traversalDirection = threadTraversalDirectionFromCommand(command);
  const targetThreadKey =
    traversalDirection !== null
      ? resolveAdjacentThreadId({
          threadIds: input.orderedThreadKeys,
          currentThreadId: input.currentThreadKey,
          direction: traversalDirection,
        })
      : (() => {
          const jumpIndex = threadJumpIndexFromCommand(command ?? "");
          return jumpIndex === null ? null : (input.jumpThreadKeys[jumpIndex] ?? null);
        })();
  if (!targetThreadKey) return false;

  const targetThread = input.threadByKey.get(targetThreadKey);
  if (!targetThread) return false;
  input.event.preventDefault();
  input.event.stopPropagation();
  input.navigateToThread(scopeThreadRef(targetThread.environmentId, targetThread.id));
  return true;
}

export function handleSidebarSelectionMouseDown(input: {
  readonly hasSelection: boolean;
  readonly target: EventTarget | null;
  readonly clearSelection: () => void;
}): boolean {
  if (!input.hasSelection) return false;
  const target = input.target instanceof HTMLElement ? input.target : null;
  if (!shouldClearThreadSelectionOnMouseDown(target)) return false;
  input.clearSelection();
  return true;
}

function SidebarThreadDetailPrewarmer({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  useEnvironmentThread(threadRef.environmentId, threadRef.threadId);
  return null;
}

function useSidebarStageLabel() {
  const primaryServerVersion =
    useAtomValue(primaryServerConfigAtom)?.environment.serverVersion ?? null;
  return resolveSidebarStageBadgeLabel({
    primaryServerVersion,
    fallbackStageLabel: APP_STAGE_LABEL,
  });
}

export function SidebarBrandContent({
  appBaseName,
  stageLabel,
}: {
  readonly appBaseName: string;
  readonly stageLabel: string | null;
}) {
  return (
    <>
      <span className="truncate text-sm font-semibold tracking-tight text-foreground">
        {appBaseName}
      </span>
      {stageLabel ? (
        <span className="sidebar-brand-stage shrink-0 items-center whitespace-nowrap rounded-full bg-muted/50 px-1.5 py-0.5 text-[8px] font-medium uppercase tracking-[0.18em] text-muted-foreground/60">
          {stageLabel}
        </span>
      ) : null}
    </>
  );
}

function SidebarBrand() {
  const stageLabel = useSidebarStageLabel();
  return (
    <Link
      aria-label="Go to threads"
      className="sidebar-brand ml-[var(--workspace-titlebar-content-left)] h-7 w-fit min-w-0 shrink-0 items-center gap-1 overflow-hidden rounded-md text-foreground outline-hidden ring-ring focus-visible:ring-2"
      to="/"
    >
      <SidebarBrandContent appBaseName={APP_BASE_NAME} stageLabel={stageLabel} />
    </Link>
  );
}

const SidebarChromeHeader = memo(function SidebarChromeHeader() {
  return (
    <SidebarHeader className="@container/sidebar-header h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center px-3 py-0 md:px-0">
      <SidebarTrigger className="md:hidden" />
      <SidebarBrand />
    </SidebarHeader>
  );
});

const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const handleSettingsClick = useCallback(() => {
    if (isMobile) setOpenMobile(false);
    void navigate({ to: "/settings" });
  }, [isMobile, navigate, setOpenMobile]);

  return (
    <SidebarFooter className="p-2">
      <SidebarProviderUpdatePill />
      <SidebarUpdatePill />
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            size="sm"
            className="gap-2 px-2 py-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
            onClick={handleSettingsClick}
          >
            <SettingsIcon className="size-3.5" />
            <span className="text-xs">Settings</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  );
});

interface SidebarEnvironmentTreeContentProps {
  readonly projection: EnvironmentTreeProjection;
  readonly searchQuery: string;
  readonly pinnedThreadKeys: readonly string[];
  readonly unreadThreadKeys: readonly string[];
  readonly onSearchQueryChange: (query: string) => void;
  readonly onOpenAddProject: () => void;
  readonly onToggle: (
    row: Extract<EnvironmentTreeRow, { readonly kind: "environment" | "project" }>,
  ) => void;
  readonly onSelect: (row: EnvironmentTreeRow) => void;
  readonly onContextMenu: (
    row: EnvironmentTreeRow,
    request: EnvironmentTreeContextMenuRequest,
  ) => void;
}

export const SidebarEnvironmentTreeContent = memo(function SidebarEnvironmentTreeContent({
  projection,
  searchQuery,
  pinnedThreadKeys,
  unreadThreadKeys,
  onSearchQueryChange,
  onOpenAddProject,
  onToggle,
  onSelect,
  onContextMenu,
}: SidebarEnvironmentTreeContentProps) {
  return (
    <SidebarContent className="min-h-0 gap-0 overflow-hidden">
      <SidebarGroup className="px-2 pt-2 pb-1">
        <div className="flex items-center gap-1.5">
          <div className="relative min-w-0 flex-1">
            <SearchIcon
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={searchQuery}
              onChange={(event) => onSearchQueryChange(event.target.value)}
              aria-label="Search environments, projects, and threads"
              placeholder="Search"
              className="h-7 pl-7 text-xs"
            />
          </div>
          <button
            type="button"
            aria-label="Add project"
            data-testid="sidebar-add-project-trigger"
            onClick={onOpenAddProject}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <FolderPlusIcon aria-hidden className="size-3.5" />
          </button>
        </div>
      </SidebarGroup>
      <EnvironmentTree
        projection={projection}
        pinnedThreadKeys={pinnedThreadKeys}
        unreadThreadKeys={unreadThreadKeys}
        onToggle={onToggle}
        onSelect={onSelect}
        onContextMenu={onContextMenu}
        onClearSearch={() => onSearchQueryChange("")}
      />
    </SidebarContent>
  );
});

function environmentKind(
  environment: ReturnType<typeof useEnvironments>["environments"][number],
): EnvironmentTreeEnvironmentInput["kind"] {
  if (environment.entry.target._tag === "PrimaryConnectionTarget") return "primary";
  return isDesktopLocalConnectionTarget(environment.entry.target) ? "wsl" : "remote";
}

function environmentStatus(
  environment: ReturnType<typeof useEnvironments>["environments"][number],
  availability: ReturnType<typeof useEnvironmentShellSummary>["statuses"][number] | undefined,
): EnvironmentTreeStatus {
  const target = environment.entry.target;
  if (target._tag === "UnavailableConnectionTarget" && target.configuredDistro !== null) {
    return target.detail.toLocaleLowerCase().includes("stopped") ? "stopped" : "setup-required";
  }
  const error = environment.connection.error?.toLocaleLowerCase() ?? "";
  if (error.includes("version") && error.includes("incompat")) return "version-incompatible";
  if (error.includes("authentication") || error.includes("credential")) {
    return "authentication-required";
  }
  switch (environment.connection.phase) {
    case "connecting":
      return "connecting";
    case "reconnecting":
      return "reconnecting";
    case "offline":
    case "error":
      return "offline";
    case "connected":
      return availability?.status === "live" ? "online" : "connecting";
    case "available":
      break;
  }
  return availability?.status === "live" ? "online" : "offline";
}

function environmentShellRevision(input: {
  readonly status: EnvironmentTreeStatus;
  readonly projects: readonly Project[];
  readonly threads: readonly SidebarThreadSummary[];
}): string {
  return [
    input.status,
    ...input.projects.map((project) => `${project.id}:${project.updatedAt}`),
    ...input.threads.map(
      (thread) =>
        `${thread.id}:${thread.updatedAt}:${thread.session?.status ?? ""}:${thread.hasPendingApprovals}:${thread.hasPendingUserInput}`,
    ),
  ].join("\u0000");
}

function rowsForEnvironment(input: {
  readonly environment: ReturnType<typeof useEnvironments>["environments"][number];
  readonly projects: readonly Project[];
  readonly threads: readonly SidebarThreadSummary[];
  readonly status: EnvironmentTreeStatus;
  readonly hasSnapshot: boolean;
  readonly snapshotUpdatedAt: string | null;
}): EnvironmentTreeEnvironmentInput {
  return {
    environmentId: input.environment.environmentId,
    kind: environmentKind(input.environment),
    status: input.status,
    label: input.environment.label,
    canonicalLabel: input.environment.entry.target.label,
    hidden: false,
    shellRevision: environmentShellRevision(input),
    cached: input.hasSnapshot && input.status !== "online",
    stale: input.status !== "online",
    lastSynchronizedAt: input.snapshotUpdatedAt,
    projects: input.projects.map((project) => {
      const threads = input.threads.filter((thread) => thread.projectId === project.id);
      return {
        id: project.id,
        title: project.title,
        workspaceRoot: project.workspaceRoot,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        activityLabel:
          resolveProjectStatusIndicator(
            threads.map((thread) => resolveThreadStatusPill({ thread })),
          )?.label ?? null,
      };
    }),
    threads: input.threads.map((thread) => ({
      id: thread.id,
      projectId: thread.projectId,
      title: thread.title,
      kind: thread.kind,
      branch: thread.branch,
      worktreePath: thread.worktreePath,
      archivedAt: thread.archivedAt,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      latestUserMessageAt: thread.latestUserMessageAt,
      activityLabel: resolveThreadStatusPill({ thread })?.label ?? null,
    })),
  };
}

function SidebarDialogs({
  activeRouteProjectRef,
  createWorktreeDialogOpen,
  createWorktreeDialogProjectRef,
  onCreateWorktreeDialogOpenChange,
  worktreeRemovalTarget,
  closeWorktreeRemovalDialog,
  onWorktreeRemoved,
}: {
  readonly activeRouteProjectRef: ScopedProjectRef | null;
  readonly createWorktreeDialogOpen: boolean;
  readonly createWorktreeDialogProjectRef: ScopedProjectRef | null;
  readonly onCreateWorktreeDialogOpenChange: (open: boolean) => void;
  readonly worktreeRemovalTarget: WorktreeRemovalTarget | null;
  readonly closeWorktreeRemovalDialog: () => void;
  readonly onWorktreeRemoved: (
    target: WorktreeRemovalTarget,
    result: WorktreeRemovalResult,
  ) => void;
}) {
  return (
    <>
      <CreateWorktreeDialog
        open={createWorktreeDialogOpen}
        onOpenChange={onCreateWorktreeDialogOpenChange}
        defaultProjectRef={createWorktreeDialogProjectRef ?? activeRouteProjectRef}
      />
      <WorktreeRemovalDialog
        open={worktreeRemovalTarget !== null}
        target={worktreeRemovalTarget}
        onOpenChange={(open) => {
          if (!open) closeWorktreeRemovalDialog();
        }}
        onRemoved={onWorktreeRemoved}
      />
    </>
  );
}

export default function Sidebar() {
  const projects = useProjects();
  const { environments, isReady: environmentCatalogReady } = useEnvironments();
  const shellSummary = useEnvironmentShellSummary();
  const sidebarThreads = useThreadShells();
  const navigate = useNavigate();
  const retryEnvironment = useAtomCommand(environmentAvailabilityCommands.retry, {
    reportFailure: false,
  });
  const pinnedThreadKeys = useSidebarWorkspaceMetaStore((state) => state.pinnedThreadKeys);
  const unreadThreadKeys = useSidebarWorkspaceMetaStore((state) => state.unreadThreadKeys);
  const togglePinnedThreadKey = useSidebarWorkspaceMetaStore((state) => state.togglePinned);
  const markThreadRowUnread = useSidebarWorkspaceMetaStore((state) => state.markUnread);
  const markThreadRowRead = useSidebarWorkspaceMetaStore((state) => state.markRead);
  const sidebarThreadSortOrder = useClientSettings((state) => state.sidebarThreadSortOrder);
  const sidebarProjectSortOrder = useClientSettings((state) => state.sidebarProjectSortOrder);
  const handleNewThread = useNewThreadHandler();
  const [createWorktreeDialogOpen, setCreateWorktreeDialogOpen] = useState(false);
  const [createWorktreeDialogProjectRef, setCreateWorktreeDialogProjectRef] =
    useState<ScopedProjectRef | null>(null);
  const openCreateWorktreeDialog = useCallback((projectRef: ScopedProjectRef | null = null) => {
    setCreateWorktreeDialogProjectRef(projectRef);
    setCreateWorktreeDialogOpen(true);
  }, []);
  const {
    archiveThread,
    confirmAndDeleteThread,
    worktreeRemovalTarget,
    requestWorktreeRemoval,
    closeWorktreeRemovalDialog,
    completeWorktreeRemoval,
  } = useThreadActions();
  const { isMobile, setOpenMobile } = useSidebar();
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const routeThreadKey = routeThreadRef ? scopedThreadKey(routeThreadRef) : null;
  const routeTerminalOpen = useThreadHasTerminalSurface(routeThreadRef);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const openAddProjectCommandPalette = useOpenAddProjectCommandPalette();
  const [treeSearchQuery, setTreeSearchQuery] = useState("");
  const environmentTreeProjectorRef =
    useRef<ReturnType<typeof createEnvironmentTreeProjector>>(null);
  environmentTreeProjectorRef.current ??= createEnvironmentTreeProjector();
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const setSelectionAnchor = useThreadSelectionStore((state) => state.setAnchor);
  const primaryEnvironmentId = usePrimaryEnvironmentId();

  const sidebarProjectByKey = useMemo(
    () =>
      new Map(
        projects.map(
          (project) =>
            [
              scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
              project,
            ] as const,
        ),
      ),
    [projects],
  );
  const sidebarThreadByKey = useMemo(
    () =>
      new Map(
        sidebarThreads.map(
          (thread) =>
            [scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread] as const,
        ),
      ),
    [sidebarThreads],
  );
  const activeRouteProjectRef = useMemo(() => {
    if (!routeThreadKey) return null;
    const thread = sidebarThreadByKey.get(routeThreadKey);
    return thread ? scopeProjectRef(thread.environmentId, thread.projectId) : null;
  }, [routeThreadKey, sidebarThreadByKey]);

  const navigateToThread = useCallback(
    (threadRef: ScopedThreadRef) => {
      if (useThreadSelectionStore.getState().selectedThreadKeys.size > 0) clearSelection();
      setSelectionAnchor(scopedThreadKey(threadRef));
      if (isMobile) setOpenMobile(false);
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [clearSelection, isMobile, navigate, setOpenMobile, setSelectionAnchor],
  );

  const treeEnvironmentInputs = useMemo<readonly EnvironmentTreeEnvironmentInput[]>(() => {
    const availabilityById = new Map(
      shellSummary.statuses.map((availability) => [availability.environmentId, availability]),
    );
    return environments.map((environment) => {
      const environmentProjects = projects.filter(
        (project) => project.environmentId === environment.environmentId,
      );
      const environmentThreads = sidebarThreads.filter(
        (thread) => thread.environmentId === environment.environmentId,
      );
      const availability = availabilityById.get(environment.environmentId);
      return rowsForEnvironment({
        environment,
        projects: environmentProjects,
        threads: environmentThreads,
        status: environmentStatus(environment, availability),
        hasSnapshot: availability?.hasSnapshot === true,
        snapshotUpdatedAt: shellSummary.latestSnapshotUpdatedAt,
      });
    });
  }, [environments, projects, shellSummary, sidebarThreads]);

  const treeSelection = useMemo(() => {
    if (routeThreadRef === null) {
      return primaryEnvironmentId === null
        ? null
        : { environmentId: primaryEnvironmentId, projectId: null, threadId: null };
    }
    const thread = sidebarThreadByKey.get(scopedThreadKey(routeThreadRef));
    return thread
      ? {
          environmentId: thread.environmentId,
          projectId: thread.projectId,
          threadId: thread.id,
        }
      : null;
  }, [primaryEnvironmentId, routeThreadRef, sidebarThreadByKey]);

  const navigationProjectCandidates = useMemo<readonly EnvironmentNavigationProjectCandidate[]>(
    () =>
      projects.flatMap((project) => {
        const projectThreads = sidebarThreads.filter(
          (thread) =>
            thread.environmentId === project.environmentId && thread.projectId === project.id,
        );
        const mainThread = projectThreads.find((thread) => thread.kind === "default");
        return mainThread
          ? [
              {
                environmentId: project.environmentId,
                projectId: project.id,
                workspaceRoot: project.workspaceRoot,
                mainThreadId: mainThread.id,
                threadIds: projectThreads.map((thread) => thread.id),
              },
            ]
          : [];
      }),
    [projects, sidebarThreads],
  );
  const navigationHydrationReady =
    environmentCatalogReady &&
    shellSummary.statuses.length === shellSummary.desiredEnvironmentCount &&
    shellSummary.statuses.every(
      (status) => status.status !== "starting" && status.status !== "synchronizing",
    );
  const { state: navigationState, update: updateNavigationState } = useEnvironmentNavigationState({
    ready: navigationHydrationReady,
    environmentIds: environments.map((environment) => environment.environmentId),
    projects: navigationProjectCandidates,
    selected: treeSelection,
  });
  const treePreferences = useMemo<EnvironmentTreePreferences>(
    () => ({
      revision: [
        navigationState.expandedEnvironmentIds.join(","),
        navigationState.expandedProjectKeys.join(","),
        navigationState.manuallyToggledKeys.join(","),
        navigationState.environmentOrder.join(","),
        JSON.stringify(navigationState.projectOrderByEnvironment),
        pinnedThreadKeys.join(","),
        sidebarProjectSortOrder,
        sidebarThreadSortOrder,
      ].join("\u0000"),
      expandedEnvironmentIds: navigationState.expandedEnvironmentIds,
      expandedProjectKeys: navigationState.expandedProjectKeys,
      manuallyToggledKeys: navigationState.manuallyToggledKeys,
      environmentOrder: navigationState.environmentOrder,
      pinnedEnvironmentIds: navigationState.pinnedEnvironmentIds,
      projectOrderByEnvironment: navigationState.projectOrderByEnvironment,
      pinnedThreadKeys,
      projectSortOrder: sidebarProjectSortOrder,
      threadSortOrder: sidebarThreadSortOrder,
    }),
    [navigationState, pinnedThreadKeys, sidebarProjectSortOrder, sidebarThreadSortOrder],
  );
  const treeProjection = environmentTreeProjectorRef.current({
    environments: treeEnvironmentInputs,
    preferences: treePreferences,
    selected: treeSelection,
    searchQuery: treeSearchQuery,
  });

  useEffect(() => {
    if (!treeProjection.environmentOrderChanged) return;
    updateNavigationState((current) => ({
      ...current,
      environmentOrder: treeProjection.environmentOrder,
    }));
  }, [
    treeProjection.environmentOrder,
    treeProjection.environmentOrderChanged,
    updateNavigationState,
  ]);

  const handleTreeToggle = useCallback(
    (row: Extract<EnvironmentTreeRow, { readonly kind: "environment" | "project" }>) => {
      updateNavigationState((current) =>
        row.kind === "environment"
          ? toggleEnvironmentDisclosure(current, row.environmentId)
          : toggleProjectDisclosure(current, row.environmentId, row.projectId),
      );
    },
    [updateNavigationState],
  );

  const handleTreeSelect = useCallback(
    (row: EnvironmentTreeRow) => {
      if (row.kind === "environment") {
        void navigate({ to: "/settings/connections" });
        return;
      }
      const thread =
        row.kind === "thread"
          ? sidebarThreadByKey.get(scopedThreadKey(scopeThreadRef(row.environmentId, row.threadId)))
          : resolveProjectMainThread(
              sidebarThreads,
              scopeProjectRef(row.environmentId, row.projectId),
            );
      if (!thread) {
        if (row.kind === "project") {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Project Main unavailable",
              description:
                "The server did not provide the permanent Main thread for this project. Reconnect the environment and try again.",
            }),
          );
        }
        return;
      }
      const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      markThreadRowRead(threadKey);
      navigateToThread(scopeThreadRef(thread.environmentId, thread.id));
    },
    [markThreadRowRead, navigate, navigateToThread, sidebarThreadByKey, sidebarThreads],
  );

  const handleTreeContextMenu = useCallback(
    (row: EnvironmentTreeRow, request: EnvironmentTreeContextMenuRequest) => {
      void (async () => {
        const api = readLocalApi();
        if (!api) return;
        const position = { x: request.clientX, y: request.clientY };
        if (row.kind === "environment") {
          const clicked = await api.contextMenu.show(
            [
              { id: "open", label: "Open overview" },
              ...(row.status === "online" ? [] : [{ id: "retry", label: "Retry connection" }]),
              { id: "settings", label: "Environment settings" },
            ],
            position,
          );
          if (clicked === "retry") void retryEnvironment(row.environmentId);
          if (clicked === "open" || clicked === "settings") {
            void navigate({ to: "/settings/connections" });
          }
          return;
        }
        if (row.kind === "project") {
          const project = sidebarProjectByKey.get(
            scopedProjectKey(scopeProjectRef(row.environmentId, row.projectId)),
          );
          if (!project) return;
          const clicked = await api.contextMenu.show(
            [
              { id: "open", label: "Open Main" },
              { id: "new-thread", label: "New thread" },
              { id: "new-worktree", label: "New worktree" },
              { id: "copy-path", label: "Copy path" },
            ],
            position,
          );
          if (clicked === "open") handleTreeSelect(row);
          if (clicked === "new-thread") {
            void handleNewThread(scopeProjectRef(row.environmentId, row.projectId));
          }
          if (clicked === "new-worktree") {
            openCreateWorktreeDialog(scopeProjectRef(row.environmentId, row.projectId));
          }
          if (clicked === "copy-path") {
            void navigator.clipboard?.writeText(project.workspaceRoot).catch(() => undefined);
          }
          return;
        }

        const threadKey = scopedThreadKey(scopeThreadRef(row.environmentId, row.threadId));
        const isPinned = selectIsPinned(pinnedThreadKeys, threadKey);
        const isUnread = selectIsUnread(unreadThreadKeys, threadKey);
        const clicked = await api.contextMenu.show(
          buildSidebarThreadContextMenuItems({ role: row.role, isPinned, isUnread }),
          position,
        );
        const threadRef = scopeThreadRef(row.environmentId, row.threadId);
        if (clicked === "open") handleTreeSelect(row);
        if (clicked === "mark-read") markThreadRowRead(threadKey);
        if (clicked === "mark-unread") markThreadRowUnread(threadKey);
        if (clicked === "toggle-pin") togglePinnedThreadKey(threadKey);
        if (clicked === "archive") void archiveThread(threadRef);
        if (clicked === "delete") void confirmAndDeleteThread(threadRef);
        if (clicked === "remove-worktree" && row.worktreePath !== null) {
          requestWorktreeRemoval({
            environmentId: row.environmentId,
            projectId: row.projectId,
            threadId: row.threadId,
            title: row.label,
            path: row.worktreePath,
            branch: row.branch,
            availability: "verification-unavailable",
            registrationState: null,
            locked: false,
          });
        }
      })();
    },
    [
      archiveThread,
      confirmAndDeleteThread,
      handleNewThread,
      handleTreeSelect,
      markThreadRowRead,
      markThreadRowUnread,
      navigate,
      openCreateWorktreeDialog,
      pinnedThreadKeys,
      requestWorktreeRemoval,
      retryEnvironment,
      sidebarProjectByKey,
      togglePinnedThreadKey,
      unreadThreadKeys,
    ],
  );

  const visibleSidebarThreadKeys = useMemo(
    () =>
      treeProjection.rows.flatMap((row) =>
        row.kind === "thread"
          ? [scopedThreadKey(scopeThreadRef(row.environmentId, row.threadId))]
          : [],
      ),
    [treeProjection.rows],
  );
  const threadJumpThreadKeys = useMemo(() => {
    const keys: string[] = [];
    for (const [index, threadKey] of visibleSidebarThreadKeys.entries()) {
      if (threadJumpCommandForIndex(index) === null) break;
      keys.push(threadKey);
    }
    return keys;
  }, [visibleSidebarThreadKeys]);
  const prewarmedSidebarThreadRefs = useMemo(
    () =>
      getSidebarThreadIdsToPrewarm(visibleSidebarThreadKeys).flatMap((threadKey) => {
        const ref = parseScopedThreadKey(threadKey);
        return ref ? [ref] : [];
      }),
    [visibleSidebarThreadKeys],
  );

  useEffect(() => {
    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      handleSidebarNavigationKeyDown({
        event,
        resolveCommand: () =>
          resolveShortcutCommand(event, keybindings, {
            platform: navigator.platform,
            context: {
              terminalFocus: isTerminalFocused(),
              terminalOpen: routeTerminalOpen,
              modelPickerOpen: isModelPickerOpen(),
            },
          }),
        orderedThreadKeys: visibleSidebarThreadKeys,
        currentThreadKey: routeThreadKey,
        jumpThreadKeys: threadJumpThreadKeys,
        threadByKey: sidebarThreadByKey,
        navigateToThread,
      });
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [
    keybindings,
    navigateToThread,
    routeTerminalOpen,
    routeThreadKey,
    sidebarThreadByKey,
    threadJumpThreadKeys,
    visibleSidebarThreadKeys,
  ]);

  useEffect(() => {
    const onMouseDown = (event: globalThis.MouseEvent) => {
      handleSidebarSelectionMouseDown({
        hasSelection: useThreadSelectionStore.getState().hasSelection(),
        target: event.target,
        clearSelection,
      });
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, [clearSelection]);

  const handleWorktreeRemoved = useCallback(
    (removedTarget: WorktreeRemovalTarget, result: WorktreeRemovalResult) => {
      void completeWorktreeRemoval(removedTarget, result).then((cleanupResult) => {
        if (cleanupResult._tag !== "Failure" || isAtomCommandInterrupted(cleanupResult)) return;
        const error = squashAtomCommandFailure(cleanupResult);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Worktree removed, but navigation failed",
            description:
              error instanceof Error
                ? error.message
                : "Select another thread from the sidebar to continue.",
          }),
        );
      });
    },
    [completeWorktreeRemoval],
  );

  return (
    <>
      <SidebarDialogs
        activeRouteProjectRef={activeRouteProjectRef}
        createWorktreeDialogOpen={createWorktreeDialogOpen}
        createWorktreeDialogProjectRef={createWorktreeDialogProjectRef}
        onCreateWorktreeDialogOpenChange={(open) => {
          setCreateWorktreeDialogOpen(open);
          if (!open) setCreateWorktreeDialogProjectRef(null);
        }}
        worktreeRemovalTarget={worktreeRemovalTarget}
        closeWorktreeRemovalDialog={closeWorktreeRemovalDialog}
        onWorktreeRemoved={handleWorktreeRemoved}
      />
      {prewarmedSidebarThreadRefs.map((threadRef) => (
        <SidebarThreadDetailPrewarmer key={scopedThreadKey(threadRef)} threadRef={threadRef} />
      ))}
      <SidebarChromeHeader />
      <SidebarEnvironmentTreeContent
        projection={treeProjection}
        searchQuery={treeSearchQuery}
        pinnedThreadKeys={pinnedThreadKeys}
        unreadThreadKeys={unreadThreadKeys}
        onSearchQueryChange={setTreeSearchQuery}
        onOpenAddProject={openAddProjectCommandPalette}
        onToggle={handleTreeToggle}
        onSelect={handleTreeSelect}
        onContextMenu={handleTreeContextMenu}
      />
      <SidebarSeparator />
      <SidebarChromeFooter />
    </>
  );
}
