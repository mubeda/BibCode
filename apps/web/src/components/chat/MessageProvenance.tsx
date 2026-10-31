import { scopeThreadRef } from "@bibcode/client-runtime/environment";
import type { EnvironmentId, OrchestrationActor, ThreadId } from "@bibcode/contracts";
import { memo, useMemo } from "react";

import { useThreadShell } from "~/state/entities";
import { AgentActorChip } from "./AgentActorChip";

/** "From <title>"; a thread this client no longer has is "From another thread". */
export function provenanceText(sourceTitle: string | null | undefined): string {
  const title = sourceTitle?.trim();
  return title ? `From ${title}` : "From another thread";
}

/**
 * Who sent a user message and where from (#139, slices X1 and X4): the agent chip, and for a
 * message an agent passed between a worktree's threads, the thread it came from. The server
 * accepts a source only on an outside agent's panel message, so a source shows beside a chip.
 * Titles and labels are untrusted text, rendered as text.
 */
export const MessageProvenance = memo(function MessageProvenance({
  actor,
  sourceThreadId,
  environmentId,
}: {
  readonly actor: OrchestrationActor | undefined;
  readonly sourceThreadId: ThreadId | undefined;
  readonly environmentId: EnvironmentId;
}) {
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
