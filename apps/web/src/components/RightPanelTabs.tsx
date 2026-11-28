import type { ContextMenuItem, PreviewSessionSnapshot } from "@bibcode/contracts";
import {
  ClipboardList,
  FileDiff,
  Files,
  GitBranch,
  GitPullRequest,
  GitPullRequestArrow,
  Globe2,
  Smartphone,
  TerminalSquare,
  Workflow,
  X,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";

import type { RightPanelSurface } from "~/rightPanelStore";
import type { DesktopPreviewOverlay } from "~/previewStateStore";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { ScrollArea } from "~/components/ui/scroll-area";
import { useTheme } from "~/hooks/useTheme";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

import { PreviewPanelShell, type PreviewPanelMode } from "./preview/PreviewPanelShell";
import { PierreEntryIcon } from "./chat/PierreEntryIcon";

export interface RightPanelTabsProps {
  mode: PreviewPanelMode;
  maximized?: boolean;
  layoutControls?: ReactNode;
  allowAddSurfaces?: boolean;
  surfaces: readonly RightPanelSurface[];
  activeSurfaceId: string | null;
  pendingSurfaceIds: ReadonlySet<string>;
  /** File tabs whose unsaved edits conflict with a newer state on disk. */
  conflictSurfaceIds?: ReadonlySet<string>;
  previewSessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  previewDesktopByTabId: Readonly<Record<string, DesktopPreviewOverlay>>;
  terminalLabelsById: ReadonlyMap<string, string>;
  onActivate: (surface: RightPanelSurface) => void;
  onCloseSurface: (surface: RightPanelSurface) => void;
  onCloseOtherSurfaces: (surface: RightPanelSurface) => void;
  onCloseSurfacesToRight: (surface: RightPanelSurface) => void;
  onCloseAllSurfaces: () => void;
  onCopyFilePath: (relativePath: string) => void;
  onSelectBrowser: () => void;
  onSelectTerminal: () => void;
  onSelectFiles: () => void;
  onSelectDiff: () => void;
  onSelectSourceControl: () => void;
  /** Opens the device pane; omitted while device previews are off or unsupported. */
  onSelectDevice?: (() => void) | undefined;
  onSelectGitManager: () => void;
  onSelectPipelines: () => void;
  onSelectPullRequest: () => void;
  browserAvailable: boolean;
  terminalAvailable?: boolean;
  filesAvailable: boolean;
  diffAvailable: boolean;
  sourceControlAvailable: boolean;
  gitManagerAvailable?: boolean;
  pipelinesAvailable?: boolean;
  pullRequestAvailable?: boolean;
  pipelinesDisabledReason?: string;
  pullRequestDisabledReason?: string;
  children: ReactNode;
}

const SURFACE_DISABLED_REASONS = {
  browser: "Browser previews are only available in the BiBCode desktop app.",
  terminal: "Terminal is unavailable while the workspace cannot be opened.",
  files: "Files are only available when a project is open.",
  diff: "Diff is only available for server threads in Git repositories.",
  sourceControl: "Source Control is only available for server threads in Git repositories.",
  gitManager: "Git Manager is only available for server threads in Git repositories.",
  pipelines: "Pipelines is only available for server threads in Git repositories.",
  pullRequest: "Pull Request is only available for server threads in Git repositories.",
} as const;

type TabContextMenuAction = "copy-path" | "close" | "close-others" | "close-to-right" | "close-all";

type DynamicRightPanelSurface = Extract<RightPanelSurface, { kind: "file" | "preview" | "plan" }>;

function isDynamicTabSurface(surface: RightPanelSurface): surface is DynamicRightPanelSurface {
  return surface.kind === "file" || surface.kind === "preview" || surface.kind === "plan";
}

function dynamicSurfaceTitle(
  surface: DynamicRightPanelSurface,
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>,
  desktopByTabId: Readonly<Record<string, DesktopPreviewOverlay>>,
): string {
  switch (surface.kind) {
    case "file":
      return surface.relativePath.slice(surface.relativePath.lastIndexOf("/") + 1);
    case "plan":
      return "Plan";
    case "preview": {
      const snapshot = surface.resourceId ? sessions[surface.resourceId] : null;
      const desktop = surface.resourceId ? desktopByTabId[surface.resourceId] : null;
      const title =
        desktop?.title ??
        (snapshot && snapshot.navStatus._tag !== "Idle" ? snapshot.navStatus.title : "");
      const url =
        desktop?.url ??
        (snapshot && snapshot.navStatus._tag !== "Idle" ? snapshot.navStatus.url : null);
      if (title.trim().length > 0) return title;
      if (!url) return "Browser";
      try {
        return new URL(url).host || "Browser";
      } catch {
        return "Browser";
      }
    }
  }
}

function DynamicSurfaceIcon({
  surface,
  theme,
}: {
  surface: DynamicRightPanelSurface;
  theme: "light" | "dark";
}) {
  switch (surface.kind) {
    case "preview":
      return <Globe2 className="size-3.5 shrink-0" aria-hidden="true" />;
    case "file":
      return (
        <PierreEntryIcon
          pathValue={surface.relativePath}
          kind="file"
          theme={theme}
          className="size-3.5"
        />
      );
    case "plan":
      return <ClipboardList className="size-3.5 shrink-0" aria-hidden="true" />;
  }
}

interface FixedSurfaceIconItem {
  readonly key:
    | "browser"
    | "terminal"
    | "files"
    | "diff"
    | "sourceControl"
    | "device"
    | "gitManager"
    | "pipelines"
    | "pullRequest";
  readonly label: string;
  readonly icon: typeof Globe2;
  readonly active: boolean;
  readonly available: boolean;
  readonly disabledReason: string | null;
  readonly onSelect: () => void;
}

export function RightPanelTabs(props: RightPanelTabsProps) {
  const { resolvedTheme } = useTheme();
  const iconBarRef = useRef<HTMLDivElement>(null);
  const tabListRef = useRef<HTMLDivElement>(null);

  const activeSurface = useMemo(
    () => props.surfaces.find((entry) => entry.id === props.activeSurfaceId) ?? null,
    [props.activeSurfaceId, props.surfaces],
  );
  const dynamicSurfaces = useMemo(
    () => props.surfaces.filter(isDynamicTabSurface),
    [props.surfaces],
  );

  const terminalAvailable = props.terminalAvailable ?? true;
  const gitManagerAvailable = props.gitManagerAvailable ?? props.diffAvailable;
  const pipelinesAvailable = props.pipelinesAvailable ?? props.diffAvailable;
  const pullRequestAvailable = props.pullRequestAvailable ?? props.diffAvailable;

  const fixedIcons = useMemo<readonly FixedSurfaceIconItem[]>(() => {
    const activeKind = activeSurface?.kind ?? null;
    const items: FixedSurfaceIconItem[] = [
      {
        key: "browser",
        label: "Browser",
        icon: Globe2,
        active: activeKind === "preview",
        available: props.browserAvailable,
        disabledReason: SURFACE_DISABLED_REASONS.browser,
        onSelect: props.onSelectBrowser,
      },
      {
        key: "terminal",
        label: "Terminal",
        icon: TerminalSquare,
        active: activeKind === "terminal",
        available: terminalAvailable,
        disabledReason: SURFACE_DISABLED_REASONS.terminal,
        onSelect: props.onSelectTerminal,
      },
      {
        key: "files",
        label: "Files",
        icon: Files,
        active: activeKind === "files",
        available: props.filesAvailable,
        disabledReason: SURFACE_DISABLED_REASONS.files,
        onSelect: props.onSelectFiles,
      },
      {
        key: "diff",
        label: "Diff",
        icon: FileDiff,
        active: activeKind === "diff",
        available: props.diffAvailable,
        disabledReason: SURFACE_DISABLED_REASONS.diff,
        onSelect: props.onSelectDiff,
      },
      {
        key: "sourceControl",
        label: "Source Control",
        icon: GitPullRequestArrow,
        active: activeKind === "sourceControl",
        available: props.sourceControlAvailable,
        disabledReason: SURFACE_DISABLED_REASONS.sourceControl,
        onSelect: props.onSelectSourceControl,
      },
    ];
    // Hidden, not disabled, while device previews are off: Settings is the way in.
    if (props.onSelectDevice !== undefined) {
      items.push({
        key: "device",
        label: "Device",
        icon: Smartphone,
        active: activeKind === "device",
        available: true,
        disabledReason: null,
        onSelect: props.onSelectDevice,
      });
    }
    items.push(
      {
        key: "gitManager",
        label: "Git Manager",
        icon: GitBranch,
        active: activeKind === "gitManager",
        available: gitManagerAvailable,
        disabledReason: SURFACE_DISABLED_REASONS.gitManager,
        onSelect: props.onSelectGitManager,
      },
      {
        key: "pipelines",
        label: "Pipelines",
        icon: Workflow,
        active: activeKind === "pipelines",
        available: pipelinesAvailable,
        disabledReason: props.pipelinesDisabledReason ?? SURFACE_DISABLED_REASONS.pipelines,
        onSelect: props.onSelectPipelines,
      },
      {
        key: "pullRequest",
        label: "Pull Request",
        icon: GitPullRequest,
        active: activeKind === "pullRequest",
        available: pullRequestAvailable,
        disabledReason: props.pullRequestDisabledReason ?? SURFACE_DISABLED_REASONS.pullRequest,
        onSelect: props.onSelectPullRequest,
      },
    );
    return items;
  }, [
    activeSurface?.kind,
    gitManagerAvailable,
    pipelinesAvailable,
    props.browserAvailable,
    props.diffAvailable,
    props.filesAvailable,
    props.onSelectBrowser,
    props.onSelectDevice,
    props.onSelectDiff,
    props.onSelectFiles,
    props.onSelectGitManager,
    props.onSelectPipelines,
    props.onSelectPullRequest,
    props.onSelectSourceControl,
    props.onSelectTerminal,
    props.pipelinesDisabledReason,
    props.pullRequestDisabledReason,
    props.sourceControlAvailable,
    pullRequestAvailable,
    terminalAvailable,
  ]);

  const handleIconBarKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (
      event.key !== "ArrowLeft" &&
      event.key !== "ArrowRight" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }
    const bar = iconBarRef.current;
    if (!bar) return;
    const buttons = Array.from(bar.querySelectorAll<HTMLButtonElement>("button"));
    if (buttons.length === 0) return;
    const currentIndex = buttons.findIndex((button) => button === document.activeElement);
    if (currentIndex < 0) return;
    event.preventDefault();
    let nextIndex = currentIndex;
    if (event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % buttons.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + buttons.length) % buttons.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = buttons.length - 1;
    }
    buttons[nextIndex]?.focus();
  }, []);

  const handleTabContextMenu = useCallback(
    async (event: ReactMouseEvent, surface: DynamicRightPanelSurface) => {
      event.preventDefault();
      event.stopPropagation();

      const api = readLocalApi();
      if (!api) return;

      const surfaceIndex = dynamicSurfaces.findIndex((entry) => entry.id === surface.id);
      if (surfaceIndex < 0) return;

      const items: ContextMenuItem<TabContextMenuAction>[] = [];
      if (surface.kind === "file") {
        items.push({ id: "copy-path", label: "Copy path" });
      }
      items.push(
        { id: "close", label: "Close" },
        {
          id: "close-others",
          label: "Close others",
          disabled: dynamicSurfaces.length <= 1,
        },
        {
          id: "close-to-right",
          label: "Close to the right",
          disabled: surfaceIndex >= dynamicSurfaces.length - 1,
        },
        {
          id: "close-all",
          label: "Close all",
          disabled: dynamicSurfaces.length === 0,
        },
      );

      const action = await api.contextMenu.show(items, { x: event.clientX, y: event.clientY });
      switch (action) {
        case "copy-path":
          if (surface.kind === "file") props.onCopyFilePath(surface.relativePath);
          break;
        case "close":
          props.onCloseSurface(surface);
          break;
        case "close-others":
          props.onCloseOtherSurfaces(surface);
          break;
        case "close-to-right":
          props.onCloseSurfacesToRight(surface);
          break;
        case "close-all":
          props.onCloseAllSurfaces();
          break;
        case null:
          break;
      }
    },
    [dynamicSurfaces, props],
  );
  const handleTabMouseDown = useCallback((event: ReactMouseEvent) => {
    if (event.button !== 1) return;
    event.preventDefault();
  }, []);
  const handleTabAuxClick = useCallback(
    (event: ReactMouseEvent, surface: DynamicRightPanelSurface) => {
      if (event.button !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      props.onCloseSurface(surface);
    },
    [props],
  );

  const activeSurfaceId = props.activeSurfaceId;
  useEffect(() => {
    if (activeSurfaceId === null) return;
    const activeTab = tabListRef.current?.querySelector<HTMLElement>("[data-active-tab='true']");
    activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeSurfaceId]);

  const showIconBar = props.allowAddSurfaces !== false;

  const dynamicTabList = (
    <ScrollArea
      ref={tabListRef}
      hideScrollbars
      scrollFade
      className="min-w-0 flex-1 rounded-none"
      data-right-panel-tab-list
    >
      <div className="flex h-full w-max min-w-full items-center gap-1">
        {dynamicSurfaces.map((surface) => {
          const active = surface.id === props.activeSurfaceId;
          const conflicted = props.conflictSurfaceIds?.has(surface.id) ?? false;
          const pending = conflicted || props.pendingSurfaceIds.has(surface.id);
          const title = dynamicSurfaceTitle(
            surface,
            props.previewSessions,
            props.previewDesktopByTabId,
          );
          const tabButton = (
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-1.5 focus-visible:outline-none"
              onClick={() => props.onActivate(surface)}
            >
              <DynamicSurfaceIcon surface={surface} theme={resolvedTheme} />
              <span className="truncate">{title}</span>
              {conflicted ? <span className="sr-only">(changed on disk)</span> : null}
            </button>
          );
          return (
            <div
              key={surface.id}
              data-active-tab={active}
              onMouseDown={handleTabMouseDown}
              onAuxClick={(event) => handleTabAuxClick(event, surface)}
              onContextMenu={(event) => void handleTabContextMenu(event, surface)}
              className={cn(
                "group flex h-7 min-w-24 max-w-44 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs transition-colors focus-within:ring-2 focus-within:ring-ring",
                active
                  ? "bg-selected text-selected-foreground"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              <Tooltip>
                <TooltipTrigger render={tabButton} />
                <TooltipPopup>{conflicted ? `${title} (changed on disk)` : title}</TooltipPopup>
              </Tooltip>
              <button
                type="button"
                className={cn(
                  "relative flex size-4 shrink-0 items-center justify-center rounded hover:bg-muted focus:opacity-100",
                  pending ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                )}
                aria-label={`Close ${title}`}
                onClick={() => props.onCloseSurface(surface)}
              >
                {pending ? (
                  <>
                    <span
                      className={cn(
                        "size-2 rounded-full group-hover:hidden",
                        conflicted ? "bg-amber-500" : "bg-current",
                      )}
                      data-file-disk-conflict={conflicted ? "" : undefined}
                      aria-hidden="true"
                    />
                    <X className="hidden size-3 group-hover:block" aria-hidden="true" />
                  </>
                ) : (
                  <X className="size-3" aria-hidden="true" />
                )}
              </button>
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );

  return (
    <PreviewPanelShell
      mode={props.mode}
      {...(props.maximized !== undefined ? { maximized: props.maximized } : {})}
    >
      <div
        className="flex shrink-0 flex-col border-b border-panel-separator bg-background"
        data-right-panel-tabbar
      >
        <div
          className={cn(
            "workspace-topbar gap-1 pl-2",
            props.mode === "inline" ? "pr-28" : "pr-3",
            props.mode === "inline" && props.maximized && COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          {showIconBar ? (
            <div
              ref={iconBarRef}
              role="toolbar"
              aria-label="Right panel surfaces"
              data-right-panel-icon-bar
              onKeyDown={handleIconBarKeyDown}
              className="flex shrink-0 items-center gap-0.5 [-webkit-app-region:no-drag]"
            >
              {fixedIcons.map((item) => {
                const Icon = item.icon;
                const tooltipText =
                  !item.available && item.disabledReason ? item.disabledReason : item.label;
                const iconButton = (
                  <button
                    type="button"
                    aria-label={item.label}
                    aria-pressed={item.active}
                    aria-disabled={!item.available ? "true" : undefined}
                    data-right-panel-icon={item.key}
                    data-active-icon={item.active ? "true" : "false"}
                    onClick={() => {
                      if (!item.available) return;
                      item.onSelect();
                    }}
                    className={cn(
                      "relative inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      !item.available
                        ? "cursor-not-allowed text-muted-foreground opacity-40"
                        : item.active
                          ? "text-foreground after:pointer-events-none after:absolute after:inset-x-1.5 after:bottom-0 after:h-0.5 after:rounded-full after:bg-foreground"
                          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                    )}
                  >
                    <Icon className="size-4 stroke-[1.75]" aria-hidden="true" />
                  </button>
                );
                return (
                  <Tooltip key={item.key}>
                    <TooltipTrigger render={iconButton} />
                    <TooltipPopup side="bottom">{tooltipText}</TooltipPopup>
                  </Tooltip>
                );
              })}
            </div>
          ) : (
            dynamicTabList
          )}
          {props.layoutControls}
        </div>
        {showIconBar && dynamicSurfaces.length > 0 ? (
          <div className="flex h-9 min-h-9 shrink-0 items-center border-t border-panel-separator/60 px-2">
            {dynamicTabList}
          </div>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {props.activeSurfaceId === null ? (
          <div className="flex min-h-0 flex-1 items-center justify-center p-6">
            <p className="text-xs text-muted-foreground">Select a surface from the bar above.</p>
          </div>
        ) : (
          props.children
        )}
      </div>
    </PreviewPanelShell>
  );
}
