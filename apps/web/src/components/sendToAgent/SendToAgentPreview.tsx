/**
 * What a person sends, shown before it goes: who it is from and to, the note, and each attachment
 * with its size and what was left out. The person can trim an attachment or remove it. The
 * dialog mounts only while open. A failed send keeps the note and the attachments, so nothing
 * the person wrote is lost.
 */
import { SEND_REQUEST_MAX_CHARS, type SendRequestAction } from "@bibcode/contracts";
import { useCallback, useId, useState, type ReactNode, type RefObject } from "react";

import { useSendToAgentStore } from "~/sendToAgentStore";
import type { SendOutcome } from "~/state/sendRequests";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Textarea } from "../ui/textarea";
import {
  canSend,
  countCharacters,
  describeSendFailure,
  SEND_TO_AGENT_ACTIONS,
  type PreviewAttachment,
  type PreviewDraft,
} from "./sendToAgent.logic";

export type { PreviewAttachment, PreviewDraft } from "./sendToAgent.logic";

export interface SendToAgentPreviewProps {
  open: boolean;
  source: { key: string; title: string };
  action: SendRequestAction;
  target: { title: string; providerLabel: string | null; newPanel: boolean };
  leadIn: string;
  initialAttachments: ReadonlyArray<PreviewAttachment>;
  extraContent?: ReactNode;
  warning?: string | null;
  onClose: () => void;
  onSend: (draft: PreviewDraft) => Promise<SendOutcome>;
  onPickAnother: () => void;
  /** Where focus goes when the preview closes; the control that opened it. */
  finalFocus?: RefObject<HTMLElement | null>;
}

const formatCount = (count: number) => count.toLocaleString("en-US");

export function SendToAgentPreview(props: SendToAgentPreviewProps) {
  return (
    <Dialog open={props.open} onOpenChange={(open) => (open ? undefined : props.onClose())}>
      {props.open ? <PreviewBody {...props} /> : null}
    </Dialog>
  );
}

function PreviewBody(props: SendToAgentPreviewProps) {
  const { action, source, target } = props;
  const noteId = useId();
  const statusId = useId();
  const note = useSendToAgentStore((state) => state.notes[source.key] ?? "");
  const setNote = useSendToAgentStore((state) => state.setNote);
  const clearNote = useSendToAgentStore((state) => state.clearNote);
  const [attachments, setAttachments] = useState(() => [...props.initialAttachments]);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<Extract<SendOutcome, { kind: "failed" }> | null>(null);

  const actionLabel = SEND_TO_AGENT_ACTIONS.find((entry) => entry.action === action)?.label ?? "";
  const verdict = canSend({ action, note, attachments, sending });
  const total =
    countCharacters(note) +
    attachments.reduce((sum, attachment) => sum + countCharacters(attachment.text), 0);
  const described = failure === null ? null : describeSendFailure(failure);

  const { onSend, onClose } = props;
  const send = useCallback(async () => {
    setSending(true);
    setFailure(null);
    const outcome = await onSend({
      leadIn: props.leadIn,
      note,
      attachments: attachments.map(({ label, text }) => ({ label, text })),
    });
    setSending(false);
    if (outcome.kind === "sent") {
      // A custom `submit` does not settle the store, so the note is cleared here too.
      clearNote(source.key);
      onClose();
    } else {
      setFailure(outcome);
    }
  }, [attachments, clearNote, note, onClose, onSend, props.leadIn, source.key]);

  return (
    <DialogPopup
      className="max-w-xl"
      {...(props.finalFocus === undefined ? {} : { finalFocus: props.finalFocus })}
    >
      <DialogHeader>
        <DialogTitle>{actionLabel}</DialogTitle>
        <DialogDescription>
          From {source.title} to {target.title}
          {target.providerLabel ? ` (${target.providerLabel})` : ""}
          {target.newPanel ? ", in a new panel" : ""}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-4">
        {props.warning ? <p className="text-sm text-warning-foreground">{props.warning}</p> : null}
        {props.leadIn ? (
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{props.leadIn}</p>
        ) : null}
        {props.extraContent}
        <div className="flex flex-col gap-1.5">
          <label htmlFor={noteId} className="font-medium text-sm">
            {action === "message" ? "Message" : "Note (optional)"}
          </label>
          <Textarea
            id={noteId}
            autoFocus
            value={note}
            onChange={(event) => setNote(source.key, event.target.value)}
            disabled={sending}
            aria-describedby={statusId}
          />
        </div>
        {attachments.map((attachment) => (
          <AttachmentEditor
            key={attachment.id}
            attachment={attachment}
            disabled={sending}
            onChange={(text) =>
              setAttachments((current) =>
                current.map((entry) => (entry.id === attachment.id ? { ...entry, text } : entry)),
              )
            }
            onRemove={() =>
              setAttachments((current) => current.filter((entry) => entry.id !== attachment.id))
            }
          />
        ))}
        <p
          id={statusId}
          className={
            total > SEND_REQUEST_MAX_CHARS
              ? "text-destructive-foreground text-xs"
              : "text-muted-foreground text-xs"
          }
        >
          {formatCount(total)} of {formatCount(SEND_REQUEST_MAX_CHARS)} characters
          {verdict.reason ? `. ${verdict.reason}` : ""}
        </p>
        <div role="alert" className="text-destructive-foreground text-sm">
          {described ? described.message : null}
        </div>
      </DialogPanel>
      <DialogFooter>
        {described?.next === "pick-another" ? (
          <Button variant="outline" onClick={props.onPickAnother}>
            Pick another agent
          </Button>
        ) : null}
        <Button variant="outline" onClick={props.onClose}>
          Cancel
        </Button>
        <Button onClick={() => void send()} disabled={!verdict.allowed}>
          {sending ? "Sending" : "Send"}
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
}

function AttachmentEditor(props: {
  attachment: PreviewAttachment;
  disabled: boolean;
  onChange: (text: string) => void;
  onRemove: () => void;
}) {
  const { attachment } = props;
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5" data-attachment={attachment.id}>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="min-w-0 truncate font-medium text-sm">
          {attachment.label}
        </label>
        <span className="shrink-0 text-muted-foreground text-xs">
          {formatCount(countCharacters(attachment.text))} characters
        </span>
        <Button
          size="xs"
          variant="ghost"
          disabled={props.disabled}
          onClick={props.onRemove}
          aria-label={`Remove ${attachment.label}`}
        >
          Remove
        </Button>
      </div>
      {attachment.leftOut ? (
        <p className="text-muted-foreground text-xs">Left out: {attachment.leftOut}</p>
      ) : null}
      <Textarea
        id={id}
        value={attachment.text}
        onChange={(event) => props.onChange(event.target.value)}
        disabled={props.disabled}
        className="font-mono"
      />
    </div>
  );
}
