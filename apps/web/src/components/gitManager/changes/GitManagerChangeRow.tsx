import { FileCode2Icon, FileMinus2Icon, FilePenLineIcon, FilePlus2Icon } from "lucide-react";
import { memo, type ComponentType, type KeyboardEvent, type MouseEvent } from "react";

import { DiffStatLabel } from "~/components/chat/DiffStatLabel";
import { Checkbox } from "~/components/ui/checkbox";
import { cn } from "~/lib/utils";

import type { ChangeRow } from "./changesList.logic";

export interface GitManagerChangeRowProps {
  readonly row: ChangeRow;
  readonly selected: boolean;
  readonly onSelect: (path: string) => void;
  readonly onToggle: (path: string) => void;
  readonly onContextMenu: (path: string, position: { x: number; y: number }) => void;
  readonly onOpenExternal: (path: string) => void;
}

interface StatusPresentation {
  readonly icon: ComponentType<{ "aria-hidden": true; className: string }>;
  readonly label: string;
  readonly badge: string;
}

const STATUS_PRESENTATION: Record<NonNullable<ChangeRow["status"]>, StatusPresentation> = {
  modified: { icon: FilePenLineIcon, label: "Modified", badge: "M" },
  added: { icon: FilePlus2Icon, label: "Added", badge: "A" },
  deleted: { icon: FileMinus2Icon, label: "Deleted", badge: "D" },
  renamed: { icon: FileCode2Icon, label: "Renamed", badge: "R" },
  copied: { icon: FileCode2Icon, label: "Copied", badge: "C" },
  untracked: { icon: FilePlus2Icon, label: "New", badge: "U" },
};

const UNKNOWN_STATUS: StatusPresentation = {
  icon: FileCode2Icon,
  label: "Changed",
  badge: "•",
};

function splitPath(path: string): { dir: string; name: string } {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separator < 0
    ? { dir: "", name: path }
    : { dir: path.slice(0, separator), name: path.slice(separator + 1) };
}

function changeRowPropsEqual(
  previous: Readonly<GitManagerChangeRowProps>,
  next: Readonly<GitManagerChangeRowProps>,
): boolean {
  const left = previous.row;
  const right = next.row;
  return (
    previous.selected === next.selected &&
    previous.onSelect === next.onSelect &&
    previous.onToggle === next.onToggle &&
    previous.onContextMenu === next.onContextMenu &&
    previous.onOpenExternal === next.onOpenExternal &&
    left.path === right.path &&
    left.status === right.status &&
    left.area === right.area &&
    left.insertions === right.insertions &&
    left.deletions === right.deletions &&
    left.inclusion === right.inclusion &&
    left.conflicted === right.conflicted &&
    left.submodule === right.submodule &&
    left.disabledReason === right.disabledReason
  );
}

export const GitManagerChangeRow = memo(function GitManagerChangeRow({
  row,
  selected,
  onSelect,
  onToggle,
  onContextMenu,
  onOpenExternal,
}: GitManagerChangeRowProps) {
  const { dir, name } = splitPath(row.path);
  const presentation = row.status === undefined ? UNKNOWN_STATUS : STATUS_PRESENTATION[row.status];
  const StatusIcon = presentation.icon;
  const disabled = row.conflicted || row.disabledReason !== null;
  const disabledReason =
    row.disabledReason ??
    (row.conflicted ? "Resolve this conflict before changing inclusion." : null);
  const descriptionId =
    disabledReason === null ? undefined : `change-disabled-${encodeURIComponent(row.path)}`;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || (event.key !== " " && event.key !== "Enter")) {
      return;
    }
    event.preventDefault();
    if (!disabled) onToggle(row.path);
  };
  const handleContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    onContextMenu(row.path, { x: event.clientX, y: event.clientY });
  };

  return (
    <div
      aria-label={`${row.path}, ${presentation.label}`}
      aria-selected={selected}
      className={cn(
        "group flex h-[29px] min-w-0 items-center gap-2 border-b border-border/35 px-2 text-xs outline-none hover:bg-accent/45 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        selected && "bg-accent/65",
      )}
      data-path={row.path}
      role="option"
      tabIndex={0}
      title={row.path}
      onClick={() => onSelect(row.path)}
      onContextMenu={handleContextMenu}
      onDoubleClick={() => onOpenExternal(row.path)}
      onKeyDown={handleKeyDown}
    >
      <Checkbox
        aria-describedby={descriptionId}
        aria-label={`${row.inclusion === "none" ? "Include" : "Exclude"} ${row.path}`}
        checked={row.inclusion === "all"}
        disabled={disabled}
        indeterminate={row.inclusion === "partial"}
        title={disabledReason ?? undefined}
        onClick={(event) => event.stopPropagation()}
        onCheckedChange={() => onToggle(row.path)}
      />
      {disabledReason === null ? null : (
        <span className="sr-only" id={descriptionId}>
          {disabledReason}
        </span>
      )}
      <span
        aria-label={presentation.label}
        className="inline-flex size-4 shrink-0 items-center justify-center font-mono text-[10px] text-muted-foreground"
        title={presentation.label}
      >
        <StatusIcon aria-hidden={true} className="size-3.5" />
        <span className="sr-only">{presentation.badge}</span>
      </span>
      <span className="shrink-0 truncate font-mono text-xs">{name}</span>
      {dir ? <span className="min-w-0 truncate text-muted-foreground">{dir}</span> : null}
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {row.conflicted ? (
          <span className="rounded bg-destructive/12 px-1 text-[10px] font-medium text-destructive">
            Conflict
          </span>
        ) : null}
        {row.submodule ? (
          <span className="rounded bg-muted px-1 text-[10px] font-medium text-muted-foreground">
            Submodule
          </span>
        ) : null}
        <DiffStatLabel
          additions={row.insertions}
          deletions={row.deletions}
          className="text-[10px]"
          layout="inline"
        />
      </span>
    </div>
  );
}, changeRowPropsEqual);
