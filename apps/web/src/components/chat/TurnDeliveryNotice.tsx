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
        <p className="text-muted-foreground">
          {uncertain
            ? `${provider} may have received this message. Retrying could deliver a duplicate.`
            : `${provider} did not receive this message. Retry to send it again.`}
        </p>
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
          aria-label="Dismiss delivery warning"
        >
          Dismiss
        </Button>
      </div>
    </div>
  );
}
