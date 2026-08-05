import type { ContextMenuItem } from "@bibcode/contracts";
import { getTerminalLabel } from "@bibcode/shared/terminalLabels";
import {
  Bot,
  ChevronLeftIcon,
  ChevronRightIcon,
  MessageSquare,
  Rows3Icon,
  TerminalSquare,
  X,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import type { CenterSurface } from "~/centerPanelStore";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/menu";

interface CenterPanelTabsProps {
  hostLabel: string;
  surfaces: readonly CenterSurface[];
  activeSurfaceId: string | null;
  terminalLabelsById?: ReadonlyMap<string, string>;
  onActivate: (surface: CenterSurface) => void;
  onCloseSurface: (surface: CenterSurface) => void;
  onCloseOtherSurfaces: (surface: CenterSurface) => void;
  onCloseSurfacesToRight: (surface: CenterSurface) => void;
  onCloseAllSurfaces: () => void;
}

type TabContextMenuAction = "close" | "close-others" | "close-to-right" | "close-all";

function centerSurfaceTitle(
  surface: CenterSurface,
  hostLabel: string,
  terminalLabelsById: ReadonlyMap<string, string> | undefined,
): string {
  switch (surface.kind) {
    case "chat-host":
      return hostLabel;
    case "chat":
      return surface.providerLabel ?? "Chat";
    case "terminal":
      return (
        surface.label ??
        terminalLabelsById?.get(surface.terminalId) ??
        getTerminalLabel(surface.terminalId)
      );
  }
}

function CenterSurfaceIcon({ surface }: { surface: CenterSurface }) {
  switch (surface.kind) {
    case "chat-host":
      return <MessageSquare className="size-3.5 shrink-0" />;
    case "chat":
      return <Bot className="size-3.5 shrink-0" />;
    case "terminal":
      return <TerminalSquare className="size-3.5 shrink-0" />;
  }
}

export function CenterPanelTabs(props: CenterPanelTabsProps) {
  const tabListRef = useRef<HTMLDivElement>(null);
  const [hasOverflow, setHasOverflow] = useState(false);

  const getTabViewport = useCallback(
    () =>
      tabListRef.current?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? null,
    [],
  );

  const handleWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      const viewport = getTabViewport();
      if (!viewport || viewport.scrollWidth <= viewport.clientWidth) return;
      if (event.deltaY === 0 || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;

      viewport.scrollLeft += event.deltaY;
      event.preventDefault();
    },
    [getTabViewport],
  );

  const scrollTabPage = useCallback(
    (direction: -1 | 1) => {
      const viewport = getTabViewport();
      if (!viewport) return;
      viewport.scrollBy({
        left: direction * Math.round(viewport.clientWidth * 0.9),
        behavior: "smooth",
      });
    },
    [getTabViewport],
  );

  const activateFromAllTabs = useCallback(
    (surface: CenterSurface, surfaceIndex: number) => {
      props.onActivate(surface);
      requestAnimationFrame(() => {
        const activationButtons = tabListRef.current?.querySelectorAll<HTMLButtonElement>(
          "[data-center-panel-tab-activation]",
        );
        activationButtons?.[surfaceIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
      });
    },
    [props],
  );

  const handleTabKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, surfaceIndex: number) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const direction = event.key === "ArrowRight" ? 1 : -1;
      const nextIndex = surfaceIndex + direction;
      const nextSurface = props.surfaces[nextIndex];
      if (!nextSurface) return;

      event.preventDefault();
      props.onActivate(nextSurface);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const activationButtons = tabListRef.current?.querySelectorAll<HTMLButtonElement>(
            "[data-center-panel-tab-activation]",
          );
          const nextButton = activationButtons?.[nextIndex];
          nextButton?.focus();
          nextButton?.scrollIntoView({ block: "nearest", inline: "nearest" });
        });
      });
    },
    [props],
  );

  const handleTabContextMenu = useCallback(
    async (event: ReactMouseEvent, surface: CenterSurface) => {
      event.preventDefault();
      event.stopPropagation();

      const api = readLocalApi();
      if (!api) return;

      const surfaceIndex = props.surfaces.findIndex((entry) => entry.id === surface.id);
      if (surfaceIndex < 0) return;

      const items: ContextMenuItem<TabContextMenuAction>[] = [
        { id: "close", label: "Close" },
        { id: "close-others", label: "Close others", disabled: props.surfaces.length <= 1 },
        {
          id: "close-to-right",
          label: "Close to the right",
          disabled: surfaceIndex >= props.surfaces.length - 1,
        },
        { id: "close-all", label: "Close all", disabled: props.surfaces.length === 0 },
      ];

      const action = await api.contextMenu.show(items, { x: event.clientX, y: event.clientY });
      switch (action) {
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
    [props],
  );

  const handleTabMouseDown = useCallback((event: ReactMouseEvent) => {
    if (event.button !== 1) return;
    event.preventDefault();
  }, []);

  const handleTabAuxClick = useCallback(
    (event: ReactMouseEvent, surface: CenterSurface) => {
      if (event.button !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      props.onCloseSurface(surface);
    },
    [props],
  );

  useEffect(() => {
    const activeTab = tabListRef.current?.querySelector<HTMLElement>("[data-active-tab='true']");
    activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [props.activeSurfaceId]);

  useEffect(() => {
    const boundary = tabListRef.current;
    const viewport = getTabViewport();
    if (!boundary || !viewport) return;

    const syncOverflow = () => {
      setHasOverflow(viewport.scrollWidth > boundary.clientWidth + 1);
    };
    syncOverflow();
    viewport.addEventListener?.("scroll", syncOverflow, { passive: true });
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(syncOverflow);
    resizeObserver?.observe(boundary);
    resizeObserver?.observe(viewport);
    return () => {
      viewport.removeEventListener?.("scroll", syncOverflow);
      resizeObserver?.disconnect();
    };
  }, [getTabViewport, props.surfaces.length]);

  if (props.surfaces.length === 0) return null;

  return (
    <div
      ref={tabListRef}
      className="group/tabbar relative isolate flex min-w-0 flex-1 self-stretch items-center overflow-hidden"
      data-center-panel-tabbar
      data-center-panel-overflow-boundary
      data-overflow={hasOverflow}
    >
      <ScrollArea
        hideScrollbars
        scrollFade
        className="min-w-0 flex-1 self-stretch rounded-none"
        data-center-panel-tab-list
        onWheel={handleWheel}
      >
        <div
          className="flex h-full w-max min-w-full items-center gap-1 px-2"
          role="tablist"
          aria-label="Workspace panels"
        >
          {props.surfaces.map((surface, surfaceIndex) => {
            const active = surface.id === props.activeSurfaceId;
            const title = centerSurfaceTitle(surface, props.hostLabel, props.terminalLabelsById);
            return (
              <div
                key={surface.id}
                data-active-tab={active}
                onMouseDown={handleTabMouseDown}
                onAuxClick={(event) => handleTabAuxClick(event, surface)}
                onContextMenu={(event) => void handleTabContextMenu(event, surface)}
                className={cn(
                  "group flex h-7 min-w-25 max-w-44 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm",
                  active
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        role="tab"
                        aria-selected={active}
                        data-center-panel-tab-activation
                        className="flex min-w-0 flex-1 items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
                        onClick={() => props.onActivate(surface)}
                        onKeyDown={(event) => handleTabKeyDown(event, surfaceIndex)}
                      >
                        <CenterSurfaceIcon surface={surface} />
                        <span className="truncate">{title}</span>
                      </button>
                    }
                  />
                  <TooltipPopup>{title}</TooltipPopup>
                </Tooltip>
                <button
                  type="button"
                  className="flex size-4 shrink-0 items-center justify-center rounded opacity-0 hover:bg-muted focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 group-hover:opacity-100"
                  aria-label={`Close ${title}`}
                  onClick={() => props.onCloseSurface(surface)}
                >
                  <X className="size-3" />
                </button>
              </div>
            );
          })}
        </div>
      </ScrollArea>
      <div
        className="relative z-10 hidden shrink-0 items-center gap-0.5 border-l border-border/60 bg-background pl-1 group-data-[overflow=true]/tabbar:flex"
        data-center-panel-overflow-navigator
      >
        <button
          type="button"
          aria-label="Previous tabs"
          title="Previous tabs"
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
          onClick={() => scrollTabPage(-1)}
        >
          <ChevronLeftIcon className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label="Next tabs"
          title="Next tabs"
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
          onClick={() => scrollTabPage(1)}
        >
          <ChevronRightIcon className="size-3.5" />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="All tabs"
            title="All tabs"
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
          >
            <Rows3Icon className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-80 w-64 overflow-y-auto">
            {props.surfaces.map((surface, surfaceIndex) => {
              const title = centerSurfaceTitle(surface, props.hostLabel, props.terminalLabelsById);
              return (
                <DropdownMenuItem
                  key={surface.id}
                  data-center-panel-all-tab-id={surface.id}
                  aria-current={surface.id === props.activeSurfaceId ? "page" : undefined}
                  onClick={() => activateFromAllTabs(surface, surfaceIndex)}
                >
                  <CenterSurfaceIcon surface={surface} />
                  <span className="truncate">{title}</span>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
