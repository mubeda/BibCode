import {
  enqueueOpenPrompt,
  markOpenPromptBlocked,
  type OpenPrompt,
  removeOpenPrompt,
  useOpenPromptStore,
} from "~/browser/openPromptQueue";
import { openLink } from "~/browser/openLink";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";

function promptLead(prompt: OpenPrompt): string {
  if (prompt.blocked) return "Your browser blocked a new tab for";
  switch (prompt.source) {
    case "agent":
      return "Agent wants to open";
    case "command":
      return "A command wants to open";
    case "link":
      return "Open";
  }
}

/**
 * A non-modal bar asking to open one address at a time; nothing opens without
 * a click. AppRoot's top banner stack positions it.
 */
export function OpenPromptBanner() {
  const prompt = useOpenPromptStore((state) => state.prompts[0] ?? null);
  const waiting = useOpenPromptStore((state) => state.prompts.length - 1);
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: true });
  if (prompt === null) return null;
  return (
    <div
      role="region"
      aria-label="Requests to open links"
      className="flex flex-wrap items-center justify-center gap-3 border-b border-border bg-background px-4 py-2 text-sm"
    >
      <span aria-live="polite" className="min-w-0 break-all">
        {promptLead(prompt)} <span className="font-mono">{prompt.url}</span> on{" "}
        {prompt.environmentLabel}
        {waiting > 0 ? (
          <span className="text-muted-foreground"> ({waiting} more waiting)</span>
        ) : null}
      </span>
      <Button
        size="xs"
        onClick={() => {
          let blocked = false;
          // Runs inside the click, so the new tab keeps its user activation.
          const outcome = openLink({
            url: prompt.url,
            threadRef: prompt.threadRef,
            invert: false,
            openPreview,
            onPopupBlocked: () => {
              blocked = true;
            },
            // A retryable failure after the tab opened: offer the same request again.
            onUnopened: () => enqueueOpenPrompt({ ...prompt, blocked: false }),
          });
          if (blocked) markOpenPromptBlocked(prompt.id);
          // A refusal shows its notice; the prompt stays so Open can be retried.
          else if (outcome === "app" || outcome === "system") removeOpenPrompt(prompt.id);
        }}
      >
        Open
      </Button>
      <Button size="xs" variant="outline" onClick={() => removeOpenPrompt(prompt.id)}>
        Dismiss
      </Button>
    </div>
  );
}
