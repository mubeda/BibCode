/**
 * What a person sends, shown before it goes: who it is from and to, the note, and each attachment
 * with its size and what was left out. The person can trim an attachment or remove it. The
 * dialog mounts only while open. A failed send keeps the note and the attachments, so nothing
 * the person wrote is lost.
 */
import { SEND_REQUEST_MAX_CHARS, type SendRequestAction } from "@bibcode/contracts";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

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
  /** Read once when the preview opens, and again on Retry; Send waits for it. */
  loadAttachments?: () => Promise<ReadonlyArray<PreviewAttachment>>;
  /** Shown when `loadAttachments` fails; defaults to `LOAD_FAILED_MESSAGE`. */
  loadFailedMessage?: string;
  /** Shown while `loadAttachments` runs; defaults to `LOADING_MESSAGE`. */
  loadingMessage?: string;
  extraContent?: ReactNode;
  warning?: string | null;
  onClose: () => void;
  onSend: (draft: PreviewDraft) => Promise<SendOutcome>;
  onPickAnother: () => void;
  /** Where focus goes when the preview closes; the control that opened it. */
  finalFocus?: RefObject<HTMLElement | null>;
}

const formatCount = (count: number) => count.toLocaleString("en-US");

export const LOADING_MESSAGE = "Reading the messages to attach";
export const LOAD_FAILED_MESSAGE = "BiBCode could not read the messages to attach. Try again.";

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
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<Extract<SendOutcome, { kind: "failed" }> | null>(null);
  const { loadAttachments } = props;
  const [loading, setLoading] = useState<"loading" | "failed" | "done">(
    loadAttachments === undefined ? "done" : "loading",
  );
  const [retried, setRetried] = useState(false);
  const retryRef = useRef<HTMLButtonElement | null>(null);
  const noteRef = useRef<HTMLTextAreaElement | null>(null);
  // Only the latest read may change the preview: a slow earlier one is ignored.
  const loadGeneration = useRef(0);
  const runLoad = useCallback(() => {
    if (loadAttachments === undefined) return;
    const generation = (loadGeneration.current += 1);
    const current = () => mounted.current && generation === loadGeneration.current;
    loadAttachments().then(
      (loaded) => {
        if (!current()) return;
        setAttachments((shown) => [...shown, ...loaded]);
        setLoading("done");
        // The Retry button goes away with the failure; focus moves on to the note.
        if (retryRef.current !== null && document.activeElement === retryRef.current) {
          noteRef.current?.focus();
        }
      },
      () => {
        if (current()) setLoading("failed");
      },
    );
  }, [loadAttachments]);
  useEffect(() => {
    runLoad();
  }, [runLoad]);
  const retryLoad = useCallback(() => {
    setLoading("loading");
    setRetried(true);
    runLoad();
  }, [runLoad]);

  const actionLabel = SEND_TO_AGENT_ACTIONS.find((entry) => entry.action === action)?.label ?? "";
  const verdict = canSend({ action, note, attachments, sending });
  const sendAllowed = verdict.allowed && loading === "done";
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
    // A custom `submit` does not settle the store, so the note is cleared here too, but only
    // the text that was sent: a preview reopened since owns whatever it holds now.
    if (outcome.kind === "sent") clearNote(source.key, note);
    // Cancel closed this preview while the send ran: a newer one may be open, so touch nothing.
    if (!mounted.current) return;
    setSending(false);
    if (outcome.kind === "sent") {
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
          {action === "take-over" ? `. Nothing is sent to ${source.title}.` : ""}
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
            ref={noteRef}
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
        {/* Both regions stay mounted, so a screen reader announces each change of their text. */}
        <div className="flex flex-col gap-1 text-sm">
          <p role="status" className="text-muted-foreground">
            {loading === "loading" ? (props.loadingMessage ?? LOADING_MESSAGE) : ""}
          </p>
          <div role="alert" className="text-destructive-foreground">
            {loading === "failed"
              ? (props.loadFailedMessage ?? LOAD_FAILED_MESSAGE)
              : described
                ? described.message
                : null}
          </div>
        </div>
        {/* Stays mounted while a retry loads, so focus stays on it. */}
        {loading === "failed" || (loading === "loading" && retried) ? (
          <Button
            ref={retryRef}
            size="xs"
            variant="outline"
            // Button styles native `disabled` only; this one stays focusable while it retries.
            className={loading === "loading" ? "self-start opacity-64" : "self-start"}
            aria-disabled={loading === "loading" ? "true" : undefined}
            onClick={loading === "failed" ? retryLoad : undefined}
          >
            {loading === "loading" ? "Retrying" : "Retry"}
          </Button>
        ) : null}
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
        <Button onClick={() => void send()} disabled={!sendAllowed}>
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
      {attachment.note ? <p className="text-muted-foreground text-xs">{attachment.note}</p> : null}
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
