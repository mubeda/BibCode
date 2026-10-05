import { FolderGit2Icon, ServerIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "../../lib/utils";
import { useUiStateStore, type SidebarView } from "../../uiStateStore";
import { SidebarGroup } from "../ui/sidebar";

const OPTIONS: ReadonlyArray<{ view: SidebarView; label: string; Icon: typeof ServerIcon }> = [
  { view: "environments", label: "Environments", Icon: ServerIcon },
  { view: "repositories", label: "Repositories", Icon: FolderGit2Icon },
];

export const SidebarViewToggle = memo(function SidebarViewToggle() {
  const sidebarView = useUiStateStore((state) => state.sidebarView);
  const setSidebarView = useUiStateStore((state) => state.setSidebarView);
  return (
    <SidebarGroup className="px-2 pt-2 pb-0">
      <div
        role="group"
        aria-label="Sidebar view"
        className="grid grid-cols-2 gap-0.5 rounded-lg bg-muted p-0.5"
      >
        {OPTIONS.map(({ view, label, Icon }) => (
          <button
            key={view}
            type="button"
            aria-label={`${label} view`}
            aria-pressed={sidebarView === view}
            onClick={() => setSidebarView(view)}
            className={cn(
              "flex h-7 items-center justify-center gap-1.5 rounded-md text-xs font-medium outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              sidebarView === view
                ? "bg-card text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon aria-hidden className="size-3.5" />
            {label}
          </button>
        ))}
      </div>
    </SidebarGroup>
  );
});
