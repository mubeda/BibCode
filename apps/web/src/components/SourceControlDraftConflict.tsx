import { sourceControlDraftKey } from "~/sourceControlDraft";
import { useSourceControlPanelStore } from "~/sourceControlPanelStore";

import { Button } from "./ui/button";

/**
 * Under a commit message box when other windows wrote different versions of this folder's
 * message at once (#219). The newest edit is in the box; each other version waits here,
 * newest first. **Use** swaps it with the box, so nothing is lost either way; **Dismiss** drops it.
 */
export function SourceControlDraftConflict(props: {
  readonly environmentId: string;
  readonly cwd: string;
}) {
  const cwdKey = sourceControlDraftKey(props);
  const alternates = useSourceControlPanelStore((state) => state.byCwdKey[cwdKey]?.alternates);
  const use = useSourceControlPanelStore((state) => state.useCwdAlternate);
  const dismiss = useSourceControlPanelStore((state) => state.dismissCwdAlternate);

  if (alternates === undefined) return null;
  return (
    <div role="status" className="space-y-0.5 px-0.5 text-xs text-muted-foreground">
      <p>Edited in more than one window. Other versions:</p>
      <ul className="space-y-0.5">
        {alternates.map((alternate) => (
          <li key={alternate} className="flex items-center gap-1">
            <span className="min-w-0 flex-1 truncate text-foreground" title={alternate}>
              “{alternate.trim().split("\n", 1)[0]}”
            </span>
            <Button size="xs" variant="outline" onClick={() => use(cwdKey, alternate)}>
              Use
            </Button>
            <Button size="xs" variant="ghost" onClick={() => dismiss(cwdKey, alternate)}>
              Dismiss
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
