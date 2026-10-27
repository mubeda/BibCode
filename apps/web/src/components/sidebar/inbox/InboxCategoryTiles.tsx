import { BellDotIcon, BotIcon, CircleCheckIcon, LoaderIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "../../../lib/utils";
import type { InboxCategory } from "../../../uiStateStore";
import { INBOX_STATUS_TONES } from "./agentRowContract";
import { INBOX_CATEGORIES, type InboxCategoryCounts } from "./inbox.logic";

const TILE_ICONS: Record<InboxCategory, { Icon: typeof BotIcon; toneClass: string }> = {
  all: { Icon: BotIcon, toneClass: "text-foreground/70" },
  attention: { Icon: BellDotIcon, toneClass: INBOX_STATUS_TONES.approval.colorClass },
  working: { Icon: LoaderIcon, toneClass: INBOX_STATUS_TONES.working.colorClass },
  done: { Icon: CircleCheckIcon, toneClass: INBOX_STATUS_TONES.completed.colorClass },
};

export interface InboxCategoryTilesProps {
  readonly counts: InboxCategoryCounts;
  readonly selected: InboxCategory;
  readonly onSelect: (category: InboxCategory) => void;
}

export const InboxCategoryTiles = memo(function InboxCategoryTiles({
  counts,
  selected,
  onSelect,
}: InboxCategoryTilesProps) {
  return (
    <div role="group" aria-label="Agent categories" className="grid grid-cols-2 gap-1.5">
      {INBOX_CATEGORIES.map(({ id, label }) => {
        const { Icon, toneClass } = TILE_ICONS[id];
        const count = counts[id];
        const isSelected = id === selected;
        return (
          <button
            key={id}
            type="button"
            aria-pressed={isSelected}
            aria-label={`${label}, ${count} ${count === 1 ? "agent" : "agents"}`}
            data-testid={`inbox-tile-${id}`}
            onClick={() => onSelect(id)}
            className={cn(
              "flex min-w-0 flex-col gap-1.5 rounded-lg border px-2.5 py-2 text-left outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              isSelected
                ? "border-ring/50 bg-card text-foreground shadow-xs"
                : "border-transparent bg-muted/50 text-foreground/80 hover:bg-accent hover:text-foreground",
            )}
          >
            <span className="flex w-full items-center gap-2">
              <Icon aria-hidden className={cn("size-4 shrink-0", toneClass)} />
              <span className="ml-auto text-xs font-medium tabular-nums text-muted-foreground">
                {count}
              </span>
            </span>
            <span className="truncate text-[13px] font-medium">{label}</span>
          </button>
        );
      })}
    </div>
  );
});
