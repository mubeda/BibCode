/**
 * The scope choice of a Review preview: what the agent is asked to look at. A scope without
 * changes stays focusable and says why it cannot be picked. The picked scope is remembered per
 * panel, like the note, so closing and reopening the preview keeps it.
 */
import { memo, useId, useState } from "react";

import type { CodeReviewScope } from "../SourceControlPanel.logic";
import { Radio, RadioGroup } from "../ui/radio-group";
import type { ReviewScopeOption } from "./review.logic";
import { REVIEW_NO_CHANGES_MESSAGE, type PreviewContent } from "./sendToAgent.logic";

export const ReviewScopePicker = memo(function ReviewScopePicker(props: {
  options: ReadonlyArray<ReviewScopeOption>;
  value: CodeReviewScope | null;
  onChange: (scope: CodeReviewScope) => void;
}) {
  const { options, value, onChange } = props;
  const groupId = useId();
  return (
    <RadioGroup
      aria-label="What to review"
      className="gap-2"
      value={value?.kind ?? ""}
      onValueChange={(next) => {
        const option = options.find((entry) => entry.scope.kind === next);
        if (option !== undefined && option.disabledReason === null) onChange(option.scope);
      }}
    >
      {options.map((option) => {
        const reasonId = `${groupId}-${option.scope.kind}`;
        const blocked = option.disabledReason !== null;
        return (
          <label key={option.scope.kind} className="flex items-start gap-2 text-sm">
            <Radio
              value={option.scope.kind}
              aria-disabled={blocked ? "true" : undefined}
              aria-describedby={blocked ? reasonId : undefined}
              className="mt-0.5"
            />
            <span className="flex min-w-0 flex-col">
              <span className={blocked ? "opacity-64" : undefined}>{option.label}</span>
              {blocked ? (
                <span id={reasonId} className="text-muted-foreground text-xs">
                  {option.disabledReason}
                </span>
              ) : null}
            </span>
          </label>
        );
      })}
    </RadioGroup>
  );
});

const pickedKinds = new Map<string, CodeReviewScope["kind"]>();

function resolveScope(
  options: ReadonlyArray<ReviewScopeOption>,
  pickKey: string,
): CodeReviewScope | null {
  const picked = pickedKinds.get(pickKey);
  const option =
    options.find((entry) => entry.scope.kind === picked && entry.disabledReason === null) ??
    options.find((entry) => entry.isDefault);
  return option?.scope ?? null;
}

function ReviewScopeSection(props: {
  options: ReadonlyArray<ReviewScopeOption>;
  pickKey: string;
  leadInFor: (scope: CodeReviewScope) => string;
}) {
  const { options, pickKey, leadInFor } = props;
  const [kind, setKind] = useState(() => resolveScope(options, pickKey)?.kind ?? null);
  const scope = options.find((option) => option.scope.kind === kind)?.scope ?? null;
  return (
    <div className="flex flex-col gap-3">
      <ReviewScopePicker
        options={options}
        value={scope}
        onChange={(next) => {
          pickedKinds.set(pickKey, next.kind);
          setKind(next.kind);
        }}
      />
      {scope !== null ? (
        <p className="whitespace-pre-wrap text-sm text-muted-foreground">{leadInFor(scope)}</p>
      ) : null}
    </div>
  );
}

/**
 * The Review preview's content: the scope picker with the lead-in of the picked scope below it,
 * and a `submit` that sends the scope picked at that moment. The lead-in is shown here, not in
 * the preview's own slot, because it changes with the scope.
 */
export function buildReviewPreviewContent(input: {
  options: ReadonlyArray<ReviewScopeOption>;
  pickKey: string;
  contentFor: (scope: CodeReviewScope) => PreviewContent;
}): PreviewContent {
  const { options, pickKey, contentFor } = input;
  const initial = resolveScope(options, pickKey);
  const extraContent = (
    <ReviewScopeSection
      options={options}
      pickKey={pickKey}
      leadInFor={(scope) => contentFor(scope).leadIn}
    />
  );
  if (initial === null) {
    return {
      leadIn: "",
      attachments: [],
      extraContent,
      warning: REVIEW_NO_CHANGES_MESSAGE,
      submit: () =>
        Promise.resolve({ kind: "failed", reason: "invalid", message: REVIEW_NO_CHANGES_MESSAGE }),
    };
  }
  return {
    leadIn: "",
    attachments: [],
    extraContent,
    warning: contentFor(initial).warning ?? null,
    submit: async (draft) => {
      const scope = resolveScope(options, pickKey) ?? initial;
      const content = contentFor(scope);
      const outcome = await content.submit!({ ...draft, leadIn: content.leadIn });
      if (outcome.kind === "sent") pickedKinds.delete(pickKey);
      return outcome;
    },
  };
}
