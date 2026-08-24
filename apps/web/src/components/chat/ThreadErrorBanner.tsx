import { memo } from "react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { CircleAlertIcon, XIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  error,
  attribution,
  onDismiss,
}: {
  error: string | null;
  /**
   * Who reported the error, e.g. "Claude reported an error". Omitted when
   * nothing truthful can be said, in which case the banner shows the message
   * alone rather than guessing at provenance.
   */
  attribution?: string | null;
  onDismiss?: () => void;
}) {
  if (!error) return null;
  return (
    // w-full: as a flex-column child, mx-auto alone disables stretch and the
    // line-clamped description collapses fit-content to a sliver-wide pill.
    <div className="mx-auto w-full max-w-3xl pt-3">
      <Alert variant="error">
        <CircleAlertIcon />
        {attribution ? <AlertTitle>{attribution}</AlertTitle> : null}
        {/* AlertDescription must be a DIRECT Alert child: Alert buckets children
            by slot, and a Tooltip wrapper matches no slot — the description then
            lands in the 16px icon bucket and renders as a squished sliver. */}
        <AlertDescription className="min-w-0">
          <Tooltip>
            <TooltipTrigger render={<div className="line-clamp-3" />}>{error}</TooltipTrigger>
            <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap">
              {error}
            </TooltipPopup>
          </Tooltip>
        </AlertDescription>
        {onDismiss && (
          <AlertAction>
            <Button variant="ghost" size="icon-xs" aria-label="Dismiss error" onClick={onDismiss}>
              <XIcon className="text-destructive" />
            </Button>
          </AlertAction>
        )}
      </Alert>
    </div>
  );
});
