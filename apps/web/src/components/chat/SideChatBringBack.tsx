import type { ScopedThreadRef } from "@bibcode/contracts";
import { CornerUpLeftIcon } from "lucide-react";
import { memo } from "react";

import { derivePhase } from "~/session-logic";
import { bringBackToHost, resolveBringBackUnavailableReason } from "~/sideChatBringBack";
import { useThreadShell } from "~/state/entities";
import { PermissionButton } from "../ui/permission-button";

export const BRING_BACK_DESCRIPTION = "Put the last answer in the thread's composer";

interface SideChatBringBackProps {
  readonly hostRef: ScopedThreadRef;
  /** `composeSideChatBringBack` of the side chat's messages. */
  readonly summary: string | null;
}

/**
 * A side chat's **Bring back**: its last answer goes into the host's composer as a draft. Only
 * this row follows the host's status, so the side chat's view does not redraw with it.
 */
export const SideChatBringBack = memo(function SideChatBringBack({
  hostRef,
  summary,
}: SideChatBringBackProps) {
  const hostRunning = derivePhase(useThreadShell(hostRef)?.session ?? null) === "running";
  const reason = resolveBringBackUnavailableReason({ hostRunning, summary });
  return (
    <div className="mx-auto mb-1.5 flex w-full max-w-3xl justify-end">
      <PermissionButton
        size="sm"
        variant="outline"
        // Enabled, the title says what it does; disabled, why not.
        permission={{ allowed: reason === null, reason: reason ?? BRING_BACK_DESCRIPTION }}
        onClick={() => {
          if (summary !== null) bringBackToHost(hostRef, summary);
        }}
      >
        <CornerUpLeftIcon />
        Bring back
      </PermissionButton>
    </div>
  );
});
