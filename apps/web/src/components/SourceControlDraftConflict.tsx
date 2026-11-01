import { sourceControlDraftKey } from "~/sourceControlDraft";
import { useSourceControlPanelStore } from "~/sourceControlPanelStore";

import { Button } from "./ui/button";

/**
 * Under a commit message box when two windows edited this folder's draft at once (#219): the
 * newer edit is in the box, and the other version waits here. **Use other version** swaps the two, so
 * nothing is lost either way; **Dismiss** keeps the box as is and drops the other version.
 */
export function SourceControlDraftConflict(props: {
  readonly environmentId: string;
  readonly cwd: string;
}) {
  const cwdKey = sourceControlDraftKey(props);
  const other = useSourceControlPanelStore((state) => state.byCwdKey[cwdKey]?.otherWindowMessage);
  const swap = useSourceControlPanelStore((state) => state.swapCwdOtherWindowMessage);
  const dismiss = useSourceControlPanelStore((state) => state.dismissCwdOtherWindowMessage);

  if (other === undefined) return null;
  const firstLine = other.trim().split("\n", 1)[0] ?? "";
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-1 gap-y-0.5 px-0.5 text-xs text-muted-foreground"
    >
      <span className="min-w-0">Edited in two windows. Other version:</span>
      <span className="min-w-0 max-w-full truncate text-foreground" title={other}>
        “{firstLine}”
      </span>
      <span className="ml-auto flex gap-1">
        <Button size="xs" variant="outline" onClick={() => swap(cwdKey)}>
          Use other version
        </Button>
        <Button size="xs" variant="ghost" onClick={() => dismiss(cwdKey)}>
          Dismiss
        </Button>
      </span>
    </div>
  );
}
