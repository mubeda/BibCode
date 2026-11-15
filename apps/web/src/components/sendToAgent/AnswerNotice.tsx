/**
 * The notice a Review or Second opinion leaves in the panel it was sent from once the other
 * agent answered, or did not. Bring back reads the answer kept with the request, quotes it into
 * this panel's composer as a draft and dismisses the notice. It never sends. The notice lives in
 * the polite status region of the request rows, so a new one is announced without moving focus.
 */
import { scopeThreadRef } from "@bibcode/client-runtime/environment";
import type { ScopedThreadRef, SendRequest } from "@bibcode/contracts";
import { CornerUpLeftIcon } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";

import { useSendRequestOpenedStore } from "~/sendRequestOpenedStore";
import { appendToComposerDraft, composeAnswerBringBack } from "~/sideChatBringBack";
import { useThreadShell } from "~/state/entities";
import { useGetAnswer } from "~/state/sendRequests";
import { useCenterSurfaceVisible } from "../centerSurfaceVisibility";
import { Button } from "../ui/button";
import { PermissionButton } from "../ui/permission-button";
import { describeRequestRow } from "./SendRequestRow";
import { useSendTargetOpener, type OpenSendTarget } from "./useSendTargetOpener";

export const ANSWER_READ_FAILED = "BiBCode could not read the answer. Try again.";
const BRING_BACK_DESCRIPTION = "Put the answer in this composer as a draft";
const TERMINAL_BRING_BACK_DESCRIPTION =
  "Open Message with the answer quoted; nothing is typed into the terminal";

export const AnswerNotice = memo(function AnswerNotice(props: {
  request: SendRequest;
  /** The panel the request was sent from: where the answer is drafted. */
  hostRef: ScopedThreadRef;
  onOpen: OpenSendTarget;
  onDismiss: (requestId: string) => Promise<void>;
  /** A terminal source has no composer to draft into: it receives the quoted answer instead. */
  onBringBack?: (text: string) => void;
}) {
  const { request, hostRef, onOpen, onDismiss, onBringBack } = props;
  const { requestId } = request;
  const targetRef = useMemo(
    () => scopeThreadRef(hostRef.environmentId, request.targetThreadId),
    [hostRef.environmentId, request.targetThreadId],
  );
  const title = useThreadShell(targetRef)?.title.trim() || null;
  const view = describeRequestRow(request, title);
  const open = useSendTargetOpener(hostRef.environmentId, request, targetRef, onOpen);
  const getAnswer = useGetAnswer(hostRef.environmentId);
  const markOpened = useSendRequestOpenedStore((state) => state.markOpened);
  const [phase, setPhase] = useState<"idle" | "reading" | "failed" | "dismissing">("idle");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // Seeing the notice is what opens it: the source thread stops counting as unread. A hidden host
  // stays mounted, so the notice opens when its surface is shown, not when it mounts.
  const surfaceVisible = useCenterSurfaceVisible();
  useEffect(() => {
    if (surfaceVisible) markOpened(requestId);
  }, [markOpened, requestId, surfaceVisible]);

  const bringBack = async () => {
    setPhase("reading");
    const result = await getAnswer(requestId);
    // A notice that went away (popover closed, terminal switched) must not act on a late answer.
    if (!mounted.current) return;
    const text =
      result._tag === "Success"
        ? composeAnswerBringBack({
            targetTitle: title,
            action: request.action === "review" ? "review" : "second-opinion",
            answerText: result.value.text,
            truncated: result.value.truncated,
          })
        : null;
    if (text === null) {
      if (mounted.current) setPhase("failed");
      return;
    }
    if (onBringBack === undefined) appendToComposerDraft(hostRef, text);
    else onBringBack(text);
    await onDismiss(requestId);
    if (mounted.current) setPhase("idle");
  };
  const dismiss = async () => {
    setPhase("dismissing");
    try {
      await onDismiss(requestId);
    } finally {
      if (mounted.current) setPhase("idle");
    }
  };
  const busy = phase === "reading" || phase === "dismissing";
  return (
    <div
      data-send-request-state={request.state}
      data-answer-notice={requestId}
      className="mb-1.5 flex flex-col gap-1 rounded-lg border bg-card px-3 py-1.5 text-sm"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate">{view.text}</span>
        {request.state === "answered" ? (
          <PermissionButton
            size="xs"
            variant="outline"
            permission={{
              allowed: !busy,
              reason:
                phase === "reading"
                  ? "Reading the answer"
                  : onBringBack === undefined
                    ? BRING_BACK_DESCRIPTION
                    : TERMINAL_BRING_BACK_DESCRIPTION,
            }}
            onClick={() => void bringBack()}
          >
            <CornerUpLeftIcon />
            {phase === "reading" ? "Reading the answer" : "Bring back"}
          </PermissionButton>
        ) : null}
        {view.canOpen ? (
          <Button size="xs" variant="ghost" onClick={open}>
            Open
          </Button>
        ) : null}
        <Button size="xs" variant="ghost" disabled={busy} onClick={() => void dismiss()}>
          Dismiss
        </Button>
      </div>
      {phase === "failed" ? (
        <p className="text-destructive-foreground text-xs">{ANSWER_READ_FAILED}</p>
      ) : null}
    </div>
  );
});
