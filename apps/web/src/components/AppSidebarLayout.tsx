import { useAtomValue } from "@effect/atom-react";
import { useEffect, type CSSProperties, type ReactNode } from "react";
import * as TanStackRouter from "@tanstack/react-router";

import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";
import ThreadSidebar from "./Sidebar";
import { EnvironmentRail } from "./sidebar/EnvironmentRail";
import { Sidebar, SidebarProvider, SidebarRail, SidebarTrigger, useSidebar } from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
const ENVIRONMENT_RAIL_WIDTH = 52;
const THREAD_SIDEBAR_MIN_WIDTH = 13 * 16 + ENVIRONMENT_RAIL_WIDTH;
// Wider than the shared primitive's 16rem default: 13px titles and 12px badges
// truncate in a 204px content column, and 268px matches the reference app's rows.
// A width the user has dragged to is stored under the storage key and wins.
const THREAD_SIDEBAR_DEFAULT_WIDTH = 268 + ENVIRONMENT_RAIL_WIDTH;
const THREAD_SIDEBAR_PROVIDER_STYLE = {
  "--sidebar-width": `${THREAD_SIDEBAR_DEFAULT_WIDTH}px`,
} as CSSProperties;
const THREAD_MAIN_CONTENT_MIN_WIDTH = 40 * 16;

const useAppPathname =
  "useLocation" in TanStackRouter
    ? () => TanStackRouter.useLocation({ select: (location) => location.pathname })
    : () => "/";

function SidebarControl() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { toggleSidebar } = useSidebar();
  const shortcutLabel = shortcutLabelForCommand(keybindings, "sidebar.toggle");

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (resolveShortcutCommand(event, keybindings) !== "sidebar.toggle") return;

      event.preventDefault();
      event.stopPropagation();
      toggleSidebar();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, toggleSidebar]);

  return (
    <div
      className="pointer-events-none fixed left-[var(--workspace-controls-left)] top-[var(--workspace-controls-top)] z-50 flex h-[var(--workspace-topbar-height)] items-center"
      data-sidebar-control=""
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarTrigger className="pointer-events-auto" aria-label="Toggle main sidebar" />
          }
        />
        <TooltipPopup side="bottom">
          Toggle main sidebar{shortcutLabel ? ` (${shortcutLabel})` : ""}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

export function AppSidebarLayout({ children }: { children: ReactNode }) {
  const navigate = TanStackRouter.useNavigate();
  const pathname = useAppPathname();
  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action === "check-for-updates") {
        void window.desktopBridge?.checkForUpdate().catch(() => undefined);
        return;
      }

      if (action === "open-settings") {
        void navigate({ to: "/settings" });
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate]);

  if (pathname === "/agents") {
    return (
      <SidebarProvider className="h-dvh! min-h-0!" defaultOpen>
        {children}
      </SidebarProvider>
    );
  }

  return (
    <SidebarProvider className="h-dvh! min-h-0!" defaultOpen style={THREAD_SIDEBAR_PROVIDER_STYLE}>
      <Sidebar
        side="left"
        collapsible="offcanvas"
        className="border-r border-border bg-card text-foreground"
        resizable={{
          minWidth: THREAD_SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: ({ nextWidth, wrapper }) =>
            wrapper.clientWidth - nextWidth >= THREAD_MAIN_CONTENT_MIN_WIDTH,
          storageKey: THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        <div className="flex h-full min-h-0 flex-row">
          <EnvironmentRail />
          <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
            <ThreadSidebar />
          </div>
        </div>
        <SidebarRail />
      </Sidebar>
      {children}
      <SidebarControl />
    </SidebarProvider>
  );
}
