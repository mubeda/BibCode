import { ExternalLinkIcon } from "lucide-react";
import { memo } from "react";

import { Button } from "~/components/ui/button";

import type { WorkingTreeFile } from "./SourceControlPanel.logic";

export interface SourceControlMergeChangesProps {
  readonly files: readonly WorkingTreeFile[];
  /** Disables Ours/Theirs while another Git operation runs; opening a file stays available. */
  readonly disabled: boolean;
  readonly onResolve: (path: string, side: "ours" | "theirs") => void;
  /** Stages the file as edited, for a conflict resolved by hand. */
  readonly onMarkResolved: (path: string) => void;
  readonly onOpenInEditor: (path: string) => void;
  /** Why files cannot open in an external editor here (e.g. none is installed). */
  readonly openInEditorDisabledReason?: string | null;
}

/** Conflicted paths of a merge in progress, each resolvable with one side or in an editor. */
export const SourceControlMergeChanges = memo(function SourceControlMergeChanges({
  files,
  disabled,
  onResolve,
  onMarkResolved,
  onOpenInEditor,
  openInEditorDisabledReason = null,
}: SourceControlMergeChangesProps) {
  return (
    <section aria-label="Merge Changes" className="border-b border-border/60 px-2 py-2">
      <h3 className="px-1 pb-1 text-xs font-medium text-muted-foreground">Merge Changes</h3>
      {openInEditorDisabledReason === null ? null : (
        <p className="px-1 pb-1 text-xs text-muted-foreground">{openInEditorDisabledReason}</p>
      )}
      {/* Bounded so the strip above stays visible and every row stays reachable. */}
      <ul className="max-h-48 space-y-0.5 overflow-y-auto">
        {files.map((file) => (
          <li className="flex min-w-0 items-center gap-1 px-1 text-xs" key={file.path}>
            <span className="min-w-0 flex-1 truncate font-mono" title={file.path}>
              {file.path}
            </span>
            <Button
              aria-label={`Open ${file.path} in editor`}
              disabled={openInEditorDisabledReason !== null}
              size="icon-xs"
              title={openInEditorDisabledReason ?? "Open in editor"}
              variant="ghost"
              onClick={() => onOpenInEditor(file.path)}
            >
              <ExternalLinkIcon aria-hidden="true" />
            </Button>
            <Button
              aria-label={`Keep ours for ${file.path}`}
              disabled={disabled}
              size="xs"
              title="Keep the current branch's version"
              variant="outline"
              onClick={() => onResolve(file.path, "ours")}
            >
              Ours
            </Button>
            <Button
              aria-label={`Take theirs for ${file.path}`}
              disabled={disabled}
              size="xs"
              title="Take the merged branch's version"
              variant="outline"
              onClick={() => onResolve(file.path, "theirs")}
            >
              Theirs
            </Button>
            <Button
              aria-label={`Mark ${file.path} resolved`}
              disabled={disabled}
              size="xs"
              title="Stage the file as you edited it"
              variant="outline"
              onClick={() => onMarkResolved(file.path)}
            >
              Mark resolved
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
});
