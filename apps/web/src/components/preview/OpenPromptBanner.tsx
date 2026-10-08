import type { ScopedThreadRef } from "@bibcode/contracts";
import { create } from "zustand";

import { openLink } from "~/browser/openLink";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";

/** Who asked: an agent's `open`, a command's `$BROWSER`, or a click whose new tab was blocked. */
export type OpenPromptSource = "agent" | "command" | "blocked";

interface OpenPrompt {
  readonly id: string;
  readonly source: OpenPromptSource;
  readonly url: string;
  readonly threadRef: ScopedThreadRef;
}

const useOpenPromptStore = create<{ prompts: readonly OpenPrompt[] }>(() => ({ prompts: [] }));
let nextPromptId = 0;

/** Queues an address that needs a click to open, because this browser tab has no user activation. */
export function enqueueOpenPrompt(prompt: Omit<OpenPrompt, "id"> & { readonly id?: string }): void {
  const id = prompt.id ?? `prompt-${++nextPromptId}`;
  useOpenPromptStore.setState(({ prompts }) =>
    prompts.some((queued) => queued.id === id)
      ? { prompts }
      : { prompts: [...prompts, { ...prompt, id }] },
  );
}

function removePrompt(id: string): void {
  useOpenPromptStore.setState(({ prompts }) => ({ prompts: prompts.filter((p) => p.id !== id) }));
}

/** Keeps a prompt whose new tab the browser blocked, so Open can be retried. */
function markBlocked(id: string): void {
  useOpenPromptStore.setState(({ prompts }) => ({
    prompts: prompts.map((p) => (p.id === id ? { ...p, source: "blocked" } : p)),
  }));
}

/** Test seam. */
export function resetOpenPromptsForTests(): void {
  useOpenPromptStore.setState({ prompts: [] });
}

function promptText(source: OpenPromptSource): string {
  switch (source) {
    case "agent":
      return "Agent wants to open";
    case "command":
      return "A command wants to open";
    case "blocked":
      return "Your browser blocked a new tab for";
  }
}

/** A non-modal bar asking to open one address at a time; nothing opens without a click. */
export function OpenPromptBanner() {
  const prompt = useOpenPromptStore((state) => state.prompts[0] ?? null);
  const waiting = useOpenPromptStore((state) => state.prompts.length - 1);
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: true });
  if (prompt === null) return null;
  return (
    <div
      role="status"
      className="fixed inset-x-0 top-0 z-50 flex flex-wrap items-center justify-center gap-3 border-b border-border bg-background px-4 py-2 text-sm"
    >
      <span className="min-w-0 break-all">
        {promptText(prompt.source)} <span className="font-mono">{prompt.url}</span>
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
            // The gateway refused after the tab opened: offer the request again.
            onUnopened: () => enqueueOpenPrompt(prompt),
          });
          if (blocked) markBlocked(prompt.id);
          // A refusal shows its notice; the prompt stays so Open can be retried.
          else if (outcome === "app" || outcome === "system") removePrompt(prompt.id);
        }}
      >
        Open
      </Button>
      <Button size="xs" variant="outline" onClick={() => removePrompt(prompt.id)}>
        Dismiss
      </Button>
    </div>
  );
}
