import { FolderGit2Icon, InboxIcon, ServerIcon } from "lucide-react";
import { memo, type RefObject, useLayoutEffect, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { useUiStateStore, type SidebarView } from "../../uiStateStore";
import { SidebarGroup } from "../ui/sidebar";

const OPTIONS: ReadonlyArray<{ view: SidebarView; label: string; Icon: typeof ServerIcon }> = [
  { view: "environments", label: "Environments", Icon: ServerIcon },
  { view: "repositories", label: "Repositories", Icon: FolderGit2Icon },
  { view: "inbox", label: "Inbox", Icon: InboxIcon },
];

/** Matches the `@min-[20rem]/view-toggle` query that shows the labels. */
const LABEL_MIN_WIDTH_REM = 20;

/**
 * Whether the container is narrower than the labels need, tracked as the CSS
 * query hides them, so the icon-only buttons alone carry a tooltip.
 */
function useLabelsHidden(ref: RefObject<HTMLDivElement | null>): boolean {
  const [hidden, setHidden] = useState(false);
  useLayoutEffect(() => {
    const node = ref.current;
    if (node === null || typeof ResizeObserver === "undefined") return;
    const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    const minWidth = LABEL_MIN_WIDTH_REM * (Number.isFinite(rootFontSize) ? rootFontSize : 16);
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width !== undefined) setHidden(width < minWidth);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return hidden;
}

export const SidebarViewToggle = memo(function SidebarViewToggle() {
  const sidebarView = useUiStateStore((state) => state.sidebarView);
  const setSidebarView = useUiStateStore((state) => state.setSidebarView);
  const containerRef = useRef<HTMLDivElement>(null);
  const labelsHidden = useLabelsHidden(containerRef);
  return (
    <SidebarGroup className="px-2 pt-2 pb-0">
      {/* Three labels need about 20rem; a narrower panel shows the icons, named by title. */}
      <div ref={containerRef} className="@container/view-toggle">
        <div
          role="group"
          aria-label="Sidebar view"
          className="grid grid-cols-3 gap-0.5 rounded-lg bg-muted p-0.5"
        >
          {OPTIONS.map(({ view, label, Icon }) => (
            <button
              key={view}
              type="button"
              aria-label={`${label} view`}
              aria-pressed={sidebarView === view}
              title={labelsHidden ? label : undefined}
              onClick={() => setSidebarView(view)}
              className={cn(
                "flex h-7 min-w-0 items-center justify-center gap-1.5 rounded-md px-1.5 text-xs font-medium outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                sidebarView === view
                  ? "bg-card text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon aria-hidden className="size-3.5 shrink-0" />
              <span className="hidden truncate @min-[20rem]/view-toggle:inline">{label}</span>
            </button>
          ))}
        </div>
      </div>
    </SidebarGroup>
  );
});
