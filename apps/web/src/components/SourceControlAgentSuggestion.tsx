import { RegistryContext } from "@effect/atom-react";
import type { EnvironmentId, UiCommitMessageIntent } from "@bibcode/contracts";
import { AsyncResult } from "effect/reactivity";
import { useContext, useEffect, useState } from "react";

import {
  isUiIntentPending,
  type PendingUiIntent,
  replacesCommitMessage,
} from "@bibcode/client-runtime/state/uiIntents";

import { sourceControlDraftKey } from "~/sourceControlDraft";
import { agentSuggestionOutcome, useSourceControlPanelStore } from "~/sourceControlPanelStore";
import { uiIntentsEnvironment } from "~/state/uiIntents";

import { Button } from "./ui/button";

type PendingCommitMessage = PendingUiIntent & UiCommitMessageIntent;

/**
 * The newest commit message an outside agent suggested for the folder `cwdKey` names, among
 * those still before their deadline on this client's clock at `now`. `intents` are in the order
 * they arrived; within a server boot the higher sequence wins, and another boot is newer.
 */
export function latestCommitMessageSuggestion(
  intents: ReadonlyArray<PendingUiIntent>,
  environmentId: EnvironmentId,
  cwdKey: string,
  now: number = Date.now(),
): PendingCommitMessage | null {
  let latest: PendingCommitMessage | null = null;
  for (const intent of intents) {
    if (
      intent.kind === "commitMessage" &&
      isUiIntentPending(intent, now) &&
      (latest === null || replacesCommitMessage(latest, intent)) &&
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
 * text. Only a new suggestion for this folder renders the caller again. An expired suggestion
 * is never applied, and one that expires while shown goes away then.
 */
function useCommitMessageSuggestion(
  environmentId: EnvironmentId,
  cwdKey: string | null,
  legacyThreadKey: string | undefined,
): PendingCommitMessage | null {
  const registry = useContext(RegistryContext);
  const [current, setCurrent] = useState<{
    readonly cwdKey: string;
    readonly intent: PendingCommitMessage | null;
  } | null>(null);
  useEffect(() => {
    if (cwdKey === null) return;
    // Each suggestion is applied once while the panel shows it: clearing the box later never
    // pulls it in again.
    let received: string | null = null;
    return registry.subscribe(
      uiIntentsEnvironment.intents({ environmentId, input: null }),
      (result) => {
        if (!AsyncResult.isSuccess(result)) return;
        const intent = latestCommitMessageSuggestion(result.value, environmentId, cwdKey);
        if (intent !== null && intent.intentId !== received) {
          received = intent.intentId;
          // The store promotes the thread's older draft before it applies the suggestion.
          useSourceControlPanelStore
            .getState()
            .receiveAgentCommitSuggestion(cwdKey, intent.intentId, intent.message, legacyThreadKey);
        }
        setCurrent((previous) =>
          previous?.cwdKey === cwdKey && previous.intent?.intentId === intent?.intentId
            ? previous
            : { cwdKey, intent },
        );
      },
      { immediate: true },
    );
  }, [cwdKey, environmentId, legacyThreadKey, registry]);
  const intent = current !== null && current.cwdKey === cwdKey ? current.intent : null;
  const intentId = intent?.intentId ?? null;
  const deadline = intent?.deadline ?? null;
  useEffect(() => {
    if (intentId === null || deadline === null) return;
    const expire = () =>
      setCurrent((previous) =>
        previous?.intent?.intentId === intentId ? { ...previous, intent: null } : previous,
      );
    const timer = setTimeout(expire, Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [deadline, intentId]);
  return intent;
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
  /** The thread's draft key from before folder drafts, promoted before a suggestion applies. */
  readonly legacyThreadKey?: string | undefined;
  readonly draftMessage: string;
}) {
  const { environmentId, cwd, legacyThreadKey, draftMessage } = props;
  const cwdKey = cwd === null ? null : sourceControlDraftKey({ environmentId, cwd });
  const suggestion = useCommitMessageSuggestion(environmentId, cwdKey, legacyThreadKey);
  const record = useSourceControlPanelStore((state) =>
    cwdKey === null ? undefined : state.agentSuggestionByCwdKey[cwdKey],
  );
  const accept = useSourceControlPanelStore((state) => state.acceptAgentCommitSuggestion);
  const undo = useSourceControlPanelStore((state) => state.undoAgentCommitSuggestion);
  const dismiss = useSourceControlPanelStore((state) => state.dismissAgentCommitSuggestion);

  if (cwdKey === null || suggestion === null) return null;
  const outcome = agentSuggestionOutcome(record, suggestion.intentId);
  const agent = agentName(suggestion);
  if (outcome === "offered") {
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
  if (outcome === "filled" && draftMessage === suggestion.message) {
    return <p className="px-0.5 text-xs text-muted-foreground">Message from {agent}</p>;
  }
  if (outcome === "used" && draftMessage === suggestion.message) {
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
