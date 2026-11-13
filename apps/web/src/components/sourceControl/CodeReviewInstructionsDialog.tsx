import { useId, useState } from "react";

import { CODE_REVIEW_INSTRUCTIONS_MAX_LENGTH } from "~/codeReview";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Textarea } from "~/components/ui/textarea";

const MAX_LABEL = CODE_REVIEW_INSTRUCTIONS_MAX_LENGTH.toLocaleString("en-US");
const TOO_LONG = `Instructions are longer than ${MAX_LABEL} characters. Shorten them to start the review.`;

export interface CodeReviewInstructionsDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** A reason the launch refused them: the dialog stays open, with the text, and shows it. */
  readonly onStart: (instructions: string) => string | null | undefined;
}

/** Adds instructions to one review only (R105); nothing is saved. */
export function CodeReviewInstructionsDialog(props: CodeReviewInstructionsDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {/* Mounted per opening, so every opening starts empty. */}
      {props.open ? <InstructionsForm {...props} /> : null}
    </Dialog>
  );
}

function InstructionsForm({ onOpenChange, onStart }: CodeReviewInstructionsDialogProps) {
  const [text, setText] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const fieldId = useId();
  const errorId = useId();
  // Over-long text stays in the field so a paste is not cut silently.
  const tooLong = text.length > CODE_REVIEW_INSTRUCTIONS_MAX_LENGTH;
  const problem = tooLong ? TOO_LONG : refusal;

  return (
    <DialogPopup className="max-w-xl">
      <DialogHeader>
        <DialogTitle>Review with instructions</DialogTitle>
        <DialogDescription>
          Added after the review prompt for this review only. Your saved prompts do not change.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="grid gap-1.5">
        <label htmlFor={fieldId} className="text-xs font-medium text-foreground">
          Instructions for this review
        </label>
        <Textarea
          id={fieldId}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setRefusal(null);
          }}
          rows={6}
          aria-invalid={problem !== null}
          aria-describedby={problem !== null ? errorId : undefined}
        />
        <div className="flex justify-between gap-2 text-xs text-muted-foreground">
          {problem !== null ? (
            <span id={errorId} className="text-destructive" role="alert">
              {problem}
            </span>
          ) : (
            <span />
          )}
          <span aria-live="polite" className="shrink-0 tabular-nums">
            {`${text.length.toLocaleString("en-US")} / ${MAX_LABEL}`}
          </span>
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={tooLong}
          onClick={() => {
            if (tooLong) return;
            const reason = onStart(text);
            if (reason) setRefusal(reason);
            else onOpenChange(false);
          }}
        >
          Start review
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
}
