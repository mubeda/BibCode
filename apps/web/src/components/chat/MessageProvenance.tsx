import { scopeThreadRef } from "@bibcode/client-runtime/environment";
import type {
  EnvironmentId,
  OrchestrationMessageActor,
  PersonSend,
  SendRequestAction,
  ThreadId,
} from "@bibcode/contracts";
import { memo, useMemo } from "react";

import { useThreadShell } from "~/state/entities";
import { parseAgentAddress } from "../sendToAgent/sendToAgent.logic";
import { AgentActorChip } from "./AgentActorChip";

/** "From <title>"; a thread this client no longer has is "From another thread". */
export function provenanceText(sourceTitle: string | null | undefined): string {
  const title = sourceTitle?.trim();
  return title ? `From ${title}` : "From another thread";
}

const PERSON_SEND_LABELS: Record<SendRequestAction, string> = {
  review: "Review",
  "second-opinion": "Second opinion",
  "hand-off": "Hand off",
  "take-over": "Take over from",
  message: "Message",
};

/**
 * "Review, sent from API refactor". A take-over reads "Take over from API refactor". A source
 * this client no longer has is "another thread". The message is the person's own, so it never
 * shows an agent chip.
 */
export function personSendText(input: {
  readonly action: SendRequestAction;
  readonly sourceTitle: string | null | undefined;
  readonly sourceKind: "thread" | "terminal";
}): string {
  const title = input.sourceTitle?.trim();
  const label = PERSON_SEND_LABELS[input.action];
  if (input.action === "take-over") return `${label} ${title || "another thread"}`;
  const place = input.sourceKind === "terminal" ? "a terminal in " : "";
  return `${label}, sent from ${place}${title || "another thread"}`;
}

/**
 * Who sent a user message and where from (#139, slices X1 and X4): the agent chip, and for a
 * message an agent passed between a worktree's threads, the thread it came from. The server
 * accepts a source only on an outside agent's panel message, so a source shows beside a chip.
 * A person's send (`personSend`) shows only its own label. Titles and labels are untrusted
 * text, rendered as text.
 */
export const MessageProvenance = memo(function MessageProvenance({
  actor,
  sourceThreadId,
  environmentId,
  personSend,
}: {
  readonly actor: OrchestrationMessageActor | undefined;
  readonly sourceThreadId: ThreadId | undefined;
  readonly environmentId: EnvironmentId;
  readonly personSend?: PersonSend | undefined;
}) {
  if (personSend) {
    return (
      <div className="flex max-w-[80%] items-center gap-1.5">
        <PersonSendLabel environmentId={environmentId} personSend={personSend} />
      </div>
    );
  }
  if (!actor && !sourceThreadId) return null;
  return (
    <div className="flex max-w-[80%] items-center gap-1.5">
      {sourceThreadId ? (
        <SourceThreadLabel environmentId={environmentId} threadId={sourceThreadId} />
      ) : null}
      {actor ? <AgentActorChip label={actor.label} /> : null}
    </div>
  );
});

function PersonSendLabel({
  environmentId,
  personSend,
}: {
  readonly environmentId: EnvironmentId;
  readonly personSend: PersonSend;
}) {
  const source = useMemo(
    () => parseAgentAddress(personSend.sourceAddress),
    [personSend.sourceAddress],
  );
  const ref = useMemo(
    () => (source === null ? null : scopeThreadRef(environmentId, source.threadId)),
    [environmentId, source],
  );
  const title = useThreadShell(ref)?.title;
  return (
    <span data-message-provenance="" className="min-w-0 truncate text-xs text-muted-foreground">
      {personSendText({
        action: personSend.action,
        sourceTitle: title,
        sourceKind: source?.terminalId ? "terminal" : "thread",
      })}
    </span>
  );
}

function SourceThreadLabel({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const ref = useMemo(() => scopeThreadRef(environmentId, threadId), [environmentId, threadId]);
  const title = useThreadShell(ref)?.title;
  return (
    <span data-message-provenance="" className="min-w-0 truncate text-xs text-muted-foreground">
      {provenanceText(title)}
    </span>
  );
}
