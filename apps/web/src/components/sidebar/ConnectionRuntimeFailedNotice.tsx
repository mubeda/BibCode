import { Button } from "../ui/button";

const reloadApp = () => window.location.reload();

/**
 * Shown in place of a loading line when the connection runtime failed to
 * build, because that catalog never becomes ready. Reloading builds it again.
 */
export function ConnectionRuntimeFailedNotice({
  onReload = reloadApp,
}: {
  readonly onReload?: (() => void) | undefined;
}) {
  return (
    <div role="alert" className="px-2 pt-4 text-center text-xs text-muted-foreground">
      <div>Connections could not start</div>
      <div className="mt-1">Reload BiBCode to try again.</div>
      <div className="mt-2 flex justify-center">
        <Button size="xs" variant="outline" onClick={onReload}>
          Reload
        </Button>
      </div>
    </div>
  );
}
