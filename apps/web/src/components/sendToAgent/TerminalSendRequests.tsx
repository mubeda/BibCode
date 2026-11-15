/**
 * The requests an AI Terminal sent, on its Send to agent control: one row per request with Open
 * and Cancel, and the answer notice with Bring back once an agent answered. They sit in a popover
 * beside the control, in the same status region the chat shows above its composer, so a state
 * change is announced without moving focus. The rows mount only while the popover is open, so
 * opening it is what marks an answer opened. Nothing here writes to the terminal.
 */
import type { ScopedThreadRef, SendRequest } from "@bibcode/contracts";
import { InboxIcon } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { AnswerNotice } from "./AnswerNotice";
import { describeRequestRow, SendRequestRows } from "./SendRequestRow";
import type { OpenSendTarget } from "./useSendTargetOpener";

export function terminalRequestsLabel(requests: ReadonlyArray<SendRequest>): string {
  const answers = requests.filter((request) => request.state === "answered").length;
  if (answers > 0) {
    return `Send requests, ${answers} ${answers === 1 ? "answer" : "answers"} waiting`;
  }
  return `Send requests, ${requests.length} ${requests.length === 1 ? "request" : "requests"}`;
}

export const TerminalSendRequests = memo(function TerminalSendRequests(props: {
  readonly threadRef: ScopedThreadRef;
  /** This terminal's requests. */
  readonly requests: ReadonlyArray<SendRequest>;
  readonly onOpen: OpenSendTarget;
  readonly onCancel: (requestId: string) => Promise<void>;
  readonly onDismiss: (requestId: string) => Promise<void>;
  readonly onBringBack: (text: string) => void;
  /** Called when the last request goes and the trigger with it, so focus is not lost. */
  readonly restoreFocus: () => void;
}) {
  const { threadRef, requests, onBringBack } = props;
  const [open, setOpen] = useState(false);
  const shown = useMemo(
    () => requests.filter((request) => describeRequestRow(request, null).showRow),
    [requests],
  );
  const bringBack = useMemo(
    () => (text: string) => {
      setOpen(false);
      onBringBack(text);
    },
    [onBringBack],
  );
  // A trigger that goes away takes the open popover with it; a later request starts closed.
  if (shown.length === 0 && open) setOpen(false);
  const hadRows = useRef(false);
  const { restoreFocus } = props;
  useEffect(() => {
    if (shown.length > 0) {
      hadRows.current = true;
      return;
    }
    if (!hadRows.current) return;
    hadRows.current = false;
    const active = document.activeElement;
    if (active === null || active === document.body) restoreFocus();
  }, [restoreFocus, shown.length]);
  if (shown.length === 0) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            type="button"
            aria-label={terminalRequestsLabel(shown)}
          />
        }
      >
        <InboxIcon />
      </PopoverTrigger>
      <PopoverPopup side="top" align="end" className="w-80 max-w-[calc(100vw-2rem)]">
        {open ? (
          <SendRequestRows
            environmentId={threadRef.environmentId}
            requests={shown}
            onOpen={props.onOpen}
            onCancel={props.onCancel}
            onDismiss={props.onDismiss}
            renderAnswer={(request) =>
              request.action === "review" || request.action === "second-opinion" ? (
                <AnswerNotice
                  request={request}
                  hostRef={threadRef}
                  onOpen={props.onOpen}
                  onDismiss={props.onDismiss}
                  onBringBack={bringBack}
                />
              ) : null
            }
          />
        ) : null}
      </PopoverPopup>
    </Popover>
  );
});
