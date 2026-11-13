import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@bibcode/client-runtime/state/runtime";
import {
  CODE_REVIEW_PROMPT_MAX_LENGTH,
  DEFAULT_CODE_REVIEW_PROMPT,
  type EnvironmentId,
  type ProjectId,
} from "@bibcode/contracts";
import { useId, useState } from "react";

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
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";

const MAX_LABEL = CODE_REVIEW_PROMPT_MAX_LENGTH.toLocaleString("en-US");

export interface CodeReviewProjectPromptDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectPrompt: string;
  readonly userPrompt: string;
}

/** Edits the project's review prompt (#293); a blank project prompt falls through to the user's. */
export function CodeReviewProjectPromptDialog(props: CodeReviewProjectPromptDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {/* Mounted per opening, so every opening starts from the stored prompt. */}
      {props.open ? <PromptForm {...props} /> : null}
    </Dialog>
  );
}

function PromptForm({
  onOpenChange,
  environmentId,
  projectId,
  projectPrompt,
  userPrompt,
}: CodeReviewProjectPromptDialogProps) {
  const fallback = userPrompt.trim().length > 0 ? userPrompt : DEFAULT_CODE_REVIEW_PROMPT;
  const [text, setText] = useState(() =>
    projectPrompt.trim().length > 0 ? projectPrompt : fallback,
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const fieldId = useId();
  const errorId = useId();

  const save = async () => {
    setSaving(true);
    setError(null);
    // Text equal to the lower level stores "", so a later user or default change still applies.
    const codeReviewPrompt = text === fallback || text.trim().length === 0 ? "" : text;
    const result = await updateProject({
      environmentId,
      input: { projectId, codeReviewPrompt },
    });
    setSaving(false);
    if (result._tag === "Success") {
      onOpenChange(false);
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    setError(
      failure instanceof Error && failure.message.trim()
        ? failure.message
        : "The review prompt was not saved. Try again.",
    );
  };

  return (
    <DialogPopup className="max-w-2xl">
      <DialogHeader>
        <DialogTitle>Review prompt for this project</DialogTitle>
        <DialogDescription>
          Every review of this project uses it. Reset to use your prompt from Settings → Agents.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="grid gap-1.5">
        <label htmlFor={fieldId} className="text-xs font-medium text-foreground">
          Review prompt
        </label>
        <Textarea
          id={fieldId}
          value={text}
          maxLength={CODE_REVIEW_PROMPT_MAX_LENGTH}
          onChange={(event) => setText(event.target.value.slice(0, CODE_REVIEW_PROMPT_MAX_LENGTH))}
          rows={12}
          disabled={saving}
          aria-invalid={error !== null}
          aria-describedby={error === null ? undefined : errorId}
        />
        <div className="flex justify-between gap-2 text-xs text-muted-foreground">
          <span id={errorId} className="text-destructive" role={error ? "alert" : undefined}>
            {error}
          </span>
          <span aria-live="polite" className="shrink-0 tabular-nums">
            {`${text.length.toLocaleString("en-US")} / ${MAX_LABEL}`}
          </span>
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button
          variant="ghost"
          size="sm"
          className="mr-auto"
          disabled={saving}
          onClick={() => setText(fallback)}
        >
          Reset
        </Button>
        <Button variant="outline" size="sm" disabled={saving} onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button size="sm" disabled={saving} onClick={() => void save()}>
          {saving ? "Saving..." : "Save"}
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
}
