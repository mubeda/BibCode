import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";

/**
 * The host's Diff surface while the chat panel thread it shows is not loaded yet, or could not
 * be. It never shows the host's diff in its place: comments from it would reach the panel.
 */
export function PanelDiffPendingState(props: {
  readonly failed: boolean;
  readonly onShowOwnDiff: () => void;
}) {
  if (!props.failed) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center gap-2 bg-background text-sm text-muted-foreground">
        <Spinner className="size-4" aria-hidden />
        Loading the chat panel's diff…
      </div>
    );
  }
  return (
    <div
      role="alert"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-background px-6 text-center text-sm text-muted-foreground"
    >
      <p>Couldn't load the chat panel's diff. The panel may have been closed.</p>
      <Button size="sm" variant="outline" onClick={props.onShowOwnDiff}>
        Show this chat's diff
      </Button>
    </div>
  );
}
