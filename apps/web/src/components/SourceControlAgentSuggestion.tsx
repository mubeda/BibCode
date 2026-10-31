import { RegistryContext } from "@effect/atom-react";
import type { EnvironmentId, UiCommitMessageIntent, UiIntent } from "@bibcode/contracts";
import { AsyncResult } from "effect/reactivity";
import { useContext, useEffect, useState } from "react";

import { sourceControlDraftKey } from "~/sourceControlDraft";
import { useSourceControlPanelStore } from "~/sourceControlPanelStore";
import { uiIntentsEnvironment } from "~/state/uiIntents";

import { Button } from "./ui/button";

/** The newest commit message an outside agent suggested for the folder `cwdKey` names. */
export function latestCommitMessageSuggestion(
  intents: ReadonlyArray<UiIntent>,
  environmentId: EnvironmentId,
  cwdKey: string,
): UiCommitMessageIntent | null {
  let latest: UiCommitMessageIntent | null = null;
  for (const intent of intents) {
    if (
      intent.kind === "commitMessage" &&
      sourceControlDraftKey({ environmentId, cwd: intent.cwd }) === cwdKey
    ) {
      latest = intent;
    }
  }
  return latest;
}

/** "Agent <label>", or "an agent" when it gave none. Labels are untrusted text. */
function agentName(intent: UiCommitMessageIntent): string {
  const label = intent.actor.label?.trim();
  return label ? `Agent ${label}` : "an agent";
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Follows the environment's pending UI intents for one folder's commit message suggestion and
 * hands each new one to the draft store, which fills an empty draft and only offers it over
 * text. Only a new suggestion for this folder renders the caller again.
 */
function useCommitMessageSuggestion(
  environmentId: EnvironmentId,
  cwdKey: string | null,
): UiCommitMessageIntent | null {
  const registry = useContext(RegistryContext);
  const [current, setCurrent] = useState<{
    readonly cwdKey: string;
    readonly intent: UiCommitMessageIntent | null;
  } | null>(null);
  useEffect(() => {
    if (cwdKey === null) return;
    return registry.subscribe(
      uiIntentsEnvironment.intents({ environmentId, input: null }),
      (result) => {
        if (!AsyncResult.isSuccess(result)) return;
        const intent = latestCommitMessageSuggestion(result.value, environmentId, cwdKey);
        if (intent !== null) {
          useSourceControlPanelStore
            .getState()
            .receiveAgentCommitSuggestion(cwdKey, intent.intentId, intent.message);
        }
        setCurrent((previous) =>
          previous?.cwdKey === cwdKey && previous.intent?.intentId === intent?.intentId
            ? previous
            : { cwdKey, intent },
        );
      },
      { immediate: true },
    );
  }, [cwdKey, environmentId, registry]);
  return current !== null && current.cwdKey === cwdKey ? current.intent : null;
}

/**
 * An outside agent's commit message suggestion under the Source Control message box (#139,
 * slice X7): **Message from Agent <label>** while the draft is the message it filled in, or
 * **Agent <label> suggested a message** with **Use it** and **Dismiss** beside text the person
 * typed, then **Undo** after **Use it**. It never commits and never replaces a draft by itself.
 */
export function SourceControlAgentSuggestion(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string | null;
  readonly draftMessage: string;
}) {
  const { environmentId, cwd, draftMessage } = props;
  const cwdKey = cwd === null ? null : sourceControlDraftKey({ environmentId, cwd });
  const suggestion = useCommitMessageSuggestion(environmentId, cwdKey);
  const handled = useSourceControlPanelStore((state) =>
    cwdKey === null ? undefined : state.agentSuggestionByCwdKey[cwdKey],
  );
  const accept = useSourceControlPanelStore((state) => state.acceptAgentCommitSuggestion);
  const undo = useSourceControlPanelStore((state) => state.undoAgentCommitSuggestion);
  const dismiss = useSourceControlPanelStore((state) => state.dismissAgentCommitSuggestion);

  if (cwdKey === null || suggestion === null || handled?.intentId !== suggestion.intentId) {
    return null;
  }
  const agent = agentName(suggestion);
  if (handled.outcome === "offered") {
    const firstLine = suggestion.message.trim().split("\n", 1)[0] ?? "";
    return (
      <div
        role="status"
        className="flex flex-wrap items-center gap-x-1 gap-y-0.5 px-0.5 text-xs text-muted-foreground"
      >
        <span className="min-w-0">{capitalized(agent)} suggested a message</span>
        <span className="min-w-0 max-w-full truncate text-foreground" title={suggestion.message}>
          “{firstLine}”
        </span>
        <span className="ml-auto flex gap-1">
          <Button
            size="xs"
            variant="outline"
            onClick={() => accept(cwdKey, suggestion.intentId, suggestion.message)}
          >
            Use it
          </Button>
          <Button size="xs" variant="ghost" onClick={() => dismiss(cwdKey, suggestion.intentId)}>
            Dismiss
          </Button>
        </span>
      </div>
    );
  }
  if (handled.outcome === "filled" && draftMessage === suggestion.message) {
    return <p className="px-0.5 text-xs text-muted-foreground">Message from {agent}</p>;
  }
  if (handled.outcome === "used" && draftMessage === suggestion.message) {
    // Use it replaced what the person typed, so they can put it back.
    return (
      <div className="flex items-center gap-1 px-0.5 text-xs text-muted-foreground">
        <span className="min-w-0">Message from {agent}</span>
        <Button
          size="xs"
          variant="ghost"
          className="ml-auto"
          onClick={() => undo(cwdKey, suggestion.intentId)}
        >
          Undo
        </Button>
      </div>
    );
  }
  return null;
}
