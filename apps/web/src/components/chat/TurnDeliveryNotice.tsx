import { PROVIDER_DISPLAY_NAMES, type TurnDelivery } from "@bibcode/contracts";

import { formatProviderDriverKindLabel } from "../../providerModels";
import { Button } from "../ui/button";

export interface TurnDeliveryNoticeProps {
  readonly delivery: TurnDelivery;
  readonly onRetry: () => void;
  readonly onDismiss: () => void;
  readonly disabled: boolean;
}

export function TurnDeliveryNotice({
  delivery,
  onRetry,
  onDismiss,
  disabled,
}: TurnDeliveryNoticeProps) {
  if (delivery.state !== "uncertain" && delivery.state !== "failed") {
    return null;
  }

  const provider =
    PROVIDER_DISPLAY_NAMES[delivery.provider] ?? formatProviderDriverKindLabel(delivery.provider);
  const uncertain = delivery.state === "uncertain";
  // A failed or uncertain delivery holds back the thread's later deliveries until the user
  // retries or dismisses it, and Retry resends it unchanged (same model and options). The copy
  // says both instead of promising that Retry clears the problem.
  const guidance = uncertain
    ? `${provider} may have received this message, and later messages wait behind it. Retrying could deliver a duplicate; Dismiss skips it.`
    : `${provider} did not receive this message, and later messages wait behind it. Retry sends it again unchanged; Dismiss skips it.`;

  return (
    <div
      role="status"
      className={`flex w-full max-w-[80%] flex-col gap-1.5 border-s-2 px-2.5 py-1.5 text-xs sm:flex-row sm:items-center sm:gap-3 ${
        uncertain
          ? "border-warning/50 bg-warning/5 text-warning-foreground"
          : "border-destructive/50 bg-destructive/5 text-destructive-foreground"
      }`}
    >
      <div className="min-w-0 flex-1">
        <p className="font-medium">{uncertain ? "Delivery uncertain" : "Delivery failed"}</p>
        {delivery.detail ? (
          <p className="wrap-break-word text-muted-foreground">{delivery.detail}</p>
        ) : null}
        <p className="text-muted-foreground">{guidance}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1 self-end sm:self-auto">
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={disabled}
          onClick={onRetry}
          aria-label="Retry message delivery"
        >
          Retry
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={disabled}
          onClick={onDismiss}
          aria-label="Dismiss and skip this message"
        >
          Dismiss
        </Button>
      </div>
    </div>
  );
}
