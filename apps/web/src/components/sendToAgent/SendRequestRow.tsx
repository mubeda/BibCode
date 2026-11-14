/**
 * The state of a person's requests above the composer: queued, waiting, delivered, read,
 * cancelled, or not answered with its reason. Every row states what the person can do next. A
 * Message, Hand off or Take over row goes away once the agent read it; a Review or Second
 * opinion row stays for its answer. The list is one polite status region, so a state change is
 * announced without moving focus.
 */
import { scopeThreadRef } from "@bibcode/client-runtime/environment";
import type {
  EnvironmentId,
  ScopedThreadRef,
  SendRequest,
  SendRequestReason,
  ThreadId,
} from "@bibcode/contracts";
import { memo, useMemo, useState, type ReactNode } from "react";

import { useThreadShell } from "~/state/entities";
import { Button } from "../ui/button";

export interface RequestRowView {
  readonly text: string;
  readonly canOpen: boolean;
  readonly canCancel: boolean;
  readonly canDismiss: boolean;
  readonly showRow: boolean;
}

const REASON_COPY: Record<SendRequestReason, string> = {
  queue_paused: "its queue is paused",
  delivery_failed: "BiBCode could not deliver it",
  turn_failed: "its turn failed",
  turn_interrupted: "its turn was interrupted",
  target_deleted: "the agent was deleted",
  no_answer: "it finished without an answer",
  recipient_gone: "the terminal closed",
};

const KEEPS_ROW_AFTER_READ = new Set<SendRequest["action"]>(["review", "second-opinion"]);

/** Requests this panel sent. A terminal's requests belong to the terminal. */
export function selectRowsForThread(
  requests: ReadonlyArray<SendRequest>,
  threadId: ThreadId,
): ReadonlyArray<SendRequest> {
  return requests.filter(
    (request) => request.source.startsWith("thread:") && request.sourceThreadId === threadId,
  );
}

export function describeRequestRow(
  request: SendRequest,
  targetTitle: string | null,
): RequestRowView {
  const agent = targetTitle ?? "the agent";
  const keepsRow = KEEPS_ROW_AFTER_READ.has(request.action);
  switch (request.state) {
    case "queued":
      return row(`Queued for ${agent}`, { canOpen: true, canCancel: true });
    case "waiting":
      return row("Waiting: this agent's queue is paused", { canOpen: true, canCancel: true });
    case "delivered":
      return row(`Delivered to ${agent}`, { canOpen: true });
    case "read":
      return { ...row(`${agent} read it`, { canOpen: true, canDismiss: true }), showRow: keepsRow };
    case "answered":
      return {
        ...row(`${agent} answered`, { canOpen: true, canDismiss: true }),
        showRow: keepsRow,
      };
    case "not_answered": {
      const reason = REASON_COPY[request.reason ?? "no_answer"];
      return row(`${agent} did not answer: ${reason}`, {
        canOpen: request.reason !== "target_deleted",
        canDismiss: true,
      });
    }
    case "cancelled":
      return row("Cancelled", { canDismiss: true });
  }
}

function row(
  text: string,
  can: { canOpen?: boolean; canCancel?: boolean; canDismiss?: boolean },
): RequestRowView {
  return {
    text,
    canOpen: can.canOpen ?? false,
    canCancel: can.canCancel ?? false,
    canDismiss: can.canDismiss ?? false,
    showRow: true,
  };
}

export interface SendRequestRowsProps {
  environmentId: EnvironmentId;
  requests: ReadonlyArray<SendRequest>;
  onOpen: (target: ScopedThreadRef) => void;
  onCancel: (requestId: string) => Promise<void>;
  onDismiss: (requestId: string) => Promise<void>;
  renderAnswer?: (request: SendRequest) => ReactNode;
}

export const SendRequestRows = memo(function SendRequestRows(props: SendRequestRowsProps) {
  const { renderAnswer } = props;
  return (
    <div role="status" aria-live="polite" className="mx-auto w-full max-w-3xl empty:hidden">
      {props.requests.map((request) => {
        const answer =
          renderAnswer !== undefined &&
          (request.state === "answered" || request.state === "not_answered")
            ? renderAnswer(request)
            : null;
        return answer !== null && answer !== undefined ? (
          <div key={request.requestId}>{answer}</div>
        ) : (
          <SendRequestRow
            key={request.requestId}
            environmentId={props.environmentId}
            request={request}
            onOpen={props.onOpen}
            onCancel={props.onCancel}
            onDismiss={props.onDismiss}
          />
        );
      })}
    </div>
  );
});

const SendRequestRow = memo(function SendRequestRow(props: {
  environmentId: EnvironmentId;
  request: SendRequest;
  onOpen: (target: ScopedThreadRef) => void;
  onCancel: (requestId: string) => Promise<void>;
  onDismiss: (requestId: string) => Promise<void>;
}) {
  const { request, environmentId } = props;
  const targetRef = useMemo(
    () => scopeThreadRef(environmentId, request.targetThreadId),
    [environmentId, request.targetThreadId],
  );
  const title = useThreadShell(targetRef)?.title.trim() || null;
  const view = describeRequestRow(request, title);
  const [busy, setBusy] = useState<"cancel" | "dismiss" | null>(null);
  if (!view.showRow) return null;
  const run = async (kind: "cancel" | "dismiss", action: (id: string) => Promise<void>) => {
    setBusy(kind);
    try {
      await action(request.requestId);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div
      data-send-request-state={request.state}
      className="mb-1.5 flex items-center gap-2 rounded-lg border bg-card px-3 py-1.5 text-sm"
    >
      <span className="min-w-0 flex-1 truncate">{view.text}</span>
      {view.canOpen ? (
        <Button size="xs" variant="ghost" onClick={() => props.onOpen(targetRef)}>
          Open
        </Button>
      ) : null}
      {view.canCancel ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={busy !== null}
          onClick={() => void run("cancel", props.onCancel)}
        >
          Cancel
        </Button>
      ) : null}
      {view.canDismiss ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={busy !== null}
          onClick={() => void run("dismiss", props.onDismiss)}
        >
          Dismiss
        </Button>
      ) : null}
    </div>
  );
});
