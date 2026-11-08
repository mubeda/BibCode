import { ChevronRight } from "lucide-react";

import type { FileBreadcrumb } from "./filePath";

/**
 * The file tab's path. Folder crumbs (and the project) are buttons that show that folder in the
 * Files tab; the file itself is the current location and stays text.
 */
export default function FileBreadcrumbTrail({
  breadcrumbs,
  projectName,
  onReveal,
}: {
  breadcrumbs: ReadonlyArray<FileBreadcrumb>;
  projectName: string;
  onReveal: (path: string) => void;
}) {
  return (
    <div className="flex h-full w-max min-w-full items-center text-xs">
      {breadcrumbs.map((crumb, index) => (
        <div
          key={crumb.path || "project"}
          className="flex min-w-0 shrink-0 items-center"
          data-current-file-crumb={crumb.kind === "file"}
        >
          {index > 0 ? (
            <ChevronRight className="mx-1 size-3.5 shrink-0 text-muted-foreground/60" />
          ) : null}
          {crumb.kind === "file" ? (
            <span className="max-w-40 truncate font-medium text-foreground" title={crumb.path}>
              {crumb.label}
            </span>
          ) : (
            <button
              type="button"
              className="max-w-40 truncate rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              title={`Show ${crumb.path || projectName} in Files`}
              onClick={() => onReveal(crumb.path)}
            >
              {crumb.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
