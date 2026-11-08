import { KeyRoundIcon, LoaderCircleIcon } from "lucide-react";
import { memo, useId } from "react";

import { Button } from "~/components/ui/button";

import { type GitSignInOffer, SIGN_IN_WAITING_MESSAGE, signInLocation } from "./gitSignIn.logic";

export interface GitSignInPromptProps {
  readonly offer: GitSignInOffer;
  readonly phase: "approval" | "waiting";
  readonly onSignIn: () => void;
  readonly onNotNow: () => void;
  readonly onCancel: () => void;
}

/**
 * Asks before Git Credential Manager opens anything (#325): it names the frozen destination and
 * the remote, so the person sees where the sign-in goes. While GCM's window is open it says so
 * and offers Cancel.
 */
export const GitSignInPrompt = memo(function GitSignInPrompt({
  offer,
  phase,
  onSignIn,
  onNotNow,
  onCancel,
}: GitSignInPromptProps) {
  const titleId = useId();
  const bodyId = useId();
  return (
    <section
      aria-describedby={bodyId}
      aria-labelledby={titleId}
      aria-live="polite"
      className="border-b border-border bg-card/70 px-3 py-2 text-xs"
    >
      <div className="flex min-w-0 items-start gap-2">
        {phase === "waiting" ? (
          <LoaderCircleIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 animate-spin" />
        ) : (
          <KeyRoundIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <p className="font-medium [overflow-wrap:anywhere]" id={titleId}>
            Sign in to <span className="font-mono">{signInLocation(offer)}</span>?
          </p>
          <p className="mt-0.5 text-muted-foreground" id={bodyId}>
            {phase === "waiting" ? (
              SIGN_IN_WAITING_MESSAGE
            ) : (
              <>
                Git Credential Manager needs you to sign in before it can{" "}
                {offer.direction === "fetch" ? "fetch from" : "push to"} remote{" "}
                <code className="font-mono">{offer.remote}</code>. It opens its own window or a
                browser page.
              </>
            )}
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          {phase === "waiting" ? (
            <Button size="xs" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          ) : (
            <>
              <Button size="xs" variant="ghost" onClick={onNotNow}>
                Not now
              </Button>
              <Button size="xs" onClick={onSignIn}>
                Sign in
              </Button>
            </>
          )}
        </div>
      </div>
    </section>
  );
});
