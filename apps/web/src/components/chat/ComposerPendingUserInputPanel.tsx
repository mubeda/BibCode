import { type ApprovalRequestId, type UserInputQuestion } from "@bibcode/contracts";
import { memo, useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  MessageCircleQuestionIcon,
  XIcon,
} from "lucide-react";
import { type PendingUserInput } from "../../session-logic";
import {
  derivePendingUserInputProgress,
  formatUserInputOptionLabel,
  isRecommendedUserInputOption,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

export interface PendingUserInputPanelProps {
  pendingUserInputs: PendingUserInput[];
  respondingRequestIds: ApprovalRequestId[];
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  collapsed?: boolean | undefined;
  canCancel?: boolean | undefined;
  canSkipAll?: boolean | undefined;
  shortcutsEnabled?: boolean | undefined;
  environmentUnavailableReason?: string | null | undefined;
  onToggleOption: (questionId: string, optionLabel: string) => void;
  onChangeCustomAnswer?: ((questionId: string, value: string) => void) | undefined;
  onSelectQuestionIndex?: ((nextIndex: number) => void) | undefined;
  onAdvance: () => void;
  onPreviousQuestion?: (() => void) | undefined;
  onSkipAndSubmit?: (() => void) | undefined;
  onToggleCollapsed?: (() => void) | undefined;
  onClose?: (() => void) | undefined;
}

export const ComposerPendingUserInputPanel = memo(function ComposerPendingUserInputPanel({
  pendingUserInputs,
  respondingRequestIds,
  answers,
  questionIndex,
  collapsed = false,
  canCancel = false,
  canSkipAll = true,
  shortcutsEnabled = true,
  environmentUnavailableReason = null,
  onToggleOption,
  onChangeCustomAnswer,
  onSelectQuestionIndex,
  onAdvance,
  onPreviousQuestion,
  onSkipAndSubmit,
  onToggleCollapsed,
  onClose,
}: PendingUserInputPanelProps) {
  if (pendingUserInputs.length === 0) return null;
  const activePrompt = pendingUserInputs[0];
  if (!activePrompt) return null;

  return (
    <ComposerPendingUserInputCard
      key={activePrompt.requestId}
      prompt={activePrompt}
      isResponding={respondingRequestIds.includes(activePrompt.requestId)}
      answers={answers}
      questionIndex={questionIndex}
      collapsed={collapsed}
      canCancel={canCancel}
      canSkipAll={canSkipAll}
      shortcutsEnabled={shortcutsEnabled}
      environmentUnavailableReason={environmentUnavailableReason}
      onToggleOption={onToggleOption}
      onChangeCustomAnswer={onChangeCustomAnswer}
      onSelectQuestionIndex={onSelectQuestionIndex}
      onAdvance={onAdvance}
      onPreviousQuestion={onPreviousQuestion}
      onSkipAndSubmit={onSkipAndSubmit}
      onToggleCollapsed={onToggleCollapsed}
      onClose={onClose}
    />
  );
});

const ComposerPendingUserInputCard = memo(function ComposerPendingUserInputCard({
  prompt,
  isResponding,
  answers,
  questionIndex,
  collapsed,
  canCancel,
  canSkipAll,
  shortcutsEnabled,
  environmentUnavailableReason,
  onToggleOption,
  onChangeCustomAnswer,
  onSelectQuestionIndex,
  onAdvance,
  onPreviousQuestion,
  onSkipAndSubmit,
  onToggleCollapsed,
  onClose,
}: {
  prompt: PendingUserInput;
  isResponding: boolean;
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  collapsed: boolean;
  canCancel: boolean;
  canSkipAll: boolean;
  shortcutsEnabled: boolean;
  environmentUnavailableReason: string | null;
  onToggleOption: (questionId: string, optionLabel: string) => void;
  onChangeCustomAnswer?: ((questionId: string, value: string) => void) | undefined;
  onSelectQuestionIndex?: ((nextIndex: number) => void) | undefined;
  onAdvance: () => void;
  onPreviousQuestion?: (() => void) | undefined;
  onSkipAndSubmit?: (() => void) | undefined;
  onToggleCollapsed?: (() => void) | undefined;
  onClose?: (() => void) | undefined;
}) {
  const progress = derivePendingUserInputProgress(prompt.questions, answers, questionIndex);
  const activeQuestion = progress.activeQuestion;
  const totalQuestions = prompt.questions.length;
  const autoAdvanceTimerRef = useRef<number | null>(null);
  const onAdvanceRef = useRef(onAdvance);
  const onToggleOptionRef = useRef(onToggleOption);
  const [optimisticSingleSelect, setOptimisticSingleSelect] = useState<{
    questionId: string;
    optionLabel: string;
  } | null>(null);

  useEffect(() => {
    onAdvanceRef.current = onAdvance;
    onToggleOptionRef.current = onToggleOption;
  }, [onAdvance, onToggleOption]);

  // Drop the optimistic pick once the question moves on or the draft answer confirms it.
  if (
    activeQuestion &&
    !activeQuestion.multiSelect &&
    optimisticSingleSelect &&
    (optimisticSingleSelect.questionId !== activeQuestion.id ||
      (progress.customAnswer.trim().length === 0 &&
        progress.selectedOptionLabels.includes(optimisticSingleSelect.optionLabel)))
  ) {
    setOptimisticSingleSelect(null);
  }

  // Clear auto-advance timer on unmount.
  useEffect(() => {
    return () => {
      if (autoAdvanceTimerRef.current !== null) {
        window.clearTimeout(autoAdvanceTimerRef.current);
      }
    };
  }, []);

  const clearAutoAdvance = useCallback(() => {
    if (autoAdvanceTimerRef.current !== null) {
      window.clearTimeout(autoAdvanceTimerRef.current);
      autoAdvanceTimerRef.current = null;
    }
  }, []);

  // Callers pass the question the option belongs to, and callbacks are read through refs.
  const selectOption = useCallback(
    (question: UserInputQuestion, optionLabel: string) => {
      if (question.multiSelect) {
        onToggleOptionRef.current(question.id, optionLabel);
        return;
      }
      setOptimisticSingleSelect({ questionId: question.id, optionLabel });
      onToggleOptionRef.current(question.id, optionLabel);
      clearAutoAdvance();
      autoAdvanceTimerRef.current = window.setTimeout(() => {
        autoAdvanceTimerRef.current = null;
        onAdvanceRef.current();
      }, 200);
    },
    [clearAutoAdvance],
  );

  const cardRef = useRef<HTMLDivElement | null>(null);

  // Keyboard shortcuts: digits 1-9 select corresponding options only while expanded,
  // scoped to the focused card in split chats (or the host pane when focus is outside cards).
  useEffect(() => {
    if (collapsed || !activeQuestion || isResponding) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        return;
      }
      if (
        target instanceof HTMLElement &&
        target.closest('[contenteditable]:not([contenteditable="false"])')
      ) {
        return;
      }
      const activeElement = document.activeElement;
      const focusedCard =
        activeElement instanceof HTMLElement
          ? activeElement.closest('[data-pending-user-input-card="true"]')
          : null;
      if (focusedCard) {
        if (focusedCard !== cardRef.current) {
          return;
        }
      } else if (!shortcutsEnabled) {
        return;
      }
      const digit = Number.parseInt(event.key, 10);
      if (Number.isNaN(digit) || digit < 1 || digit > 9) return;
      const optionIndex = digit - 1;
      if (optionIndex >= activeQuestion.options.length) return;
      const option = activeQuestion.options[optionIndex];
      if (!option) return;
      event.preventDefault();
      selectOption(activeQuestion, option.label);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [activeQuestion, collapsed, isResponding, selectOption, shortcutsEnabled]);

  if (!activeQuestion) {
    return null;
  }

  const countHeading =
    totalQuestions === 1
      ? "Awaiting user input: 1 question"
      : `Awaiting user input: ${totalQuestions} questions`;
  const customAnswerActive = progress.customAnswer.trim().length > 0;
  const submitBlockedReason = progress.isLastQuestion ? environmentUnavailableReason : null;
  const canSubmitOrNext =
    !isResponding &&
    submitBlockedReason === null &&
    (progress.isLastQuestion ? progress.isComplete : progress.canAdvance);
  const canSkipSubmit = !isResponding && environmentUnavailableReason === null;

  const handlePrevious = () => {
    clearAutoAdvance();
    if (onPreviousQuestion) {
      onPreviousQuestion();
    } else if (onSelectQuestionIndex && progress.questionIndex > 0) {
      onSelectQuestionIndex(progress.questionIndex - 1);
    }
  };

  const handleNextStep = () => {
    clearAutoAdvance();
    if (onSelectQuestionIndex && !progress.isLastQuestion) {
      onSelectQuestionIndex(progress.questionIndex + 1);
    } else {
      onAdvance();
    }
  };

  const handleCustomKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (canSubmitOrNext) {
      clearAutoAdvance();
      onAdvance();
    }
  };

  const handleCloseAction = () => {
    clearAutoAdvance();
    if (canCancel && onClose) {
      onClose();
    } else {
      onToggleCollapsed?.();
    }
  };

  if (collapsed) {
    return (
      <div
        data-pending-user-input-collapsed="true"
        className="flex items-center justify-between gap-2 rounded-t-[19px] border-b border-amber-500/30 bg-amber-500/[0.08] px-3 py-2 sm:px-4"
      >
        <div className="flex min-w-0 items-center gap-2">
          <MessageCircleQuestionIcon
            aria-hidden="true"
            className="size-4 shrink-0 text-amber-700 dark:text-amber-300"
          />
          <span className="truncate text-xs font-medium text-foreground">{countHeading}</span>
          {progress.answeredQuestionCount > 0 ? (
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {progress.answeredQuestionCount} of {totalQuestions} answered
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {onToggleCollapsed ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={onToggleCollapsed}
              aria-label="Open questions"
            >
              <ChevronUpIcon className="size-3.5" />
              Open
            </Button>
          ) : null}
          {canCancel && onClose ? (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              disabled={isResponding}
              onClick={handleCloseAction}
              aria-label="Cancel questions"
              title="Cancel questions"
            >
              <XIcon className="size-3.5" />
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={cardRef}
      data-pending-user-input-card="true"
      className="rounded-t-[19px] border-b border-amber-500/30 bg-amber-500/[0.06] px-4 py-3 dark:bg-amber-500/[0.08] sm:px-5"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <MessageCircleQuestionIcon
            aria-hidden="true"
            className="size-4 shrink-0 text-amber-700 dark:text-amber-300"
          />
          <span className="truncate text-xs font-semibold text-amber-900 dark:text-amber-200">
            {countHeading}
          </span>
          {activeQuestion.header &&
          activeQuestion.header.trim().length > 0 &&
          activeQuestion.header !== activeQuestion.question ? (
            <span className="hidden truncate rounded bg-amber-500/15 px-1.5 py-0.5 text-xs font-medium text-amber-900 dark:text-amber-200 sm:inline">
              {activeQuestion.header}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {totalQuestions > 1 ? (
            <div
              data-pending-user-input-stepper="true"
              className="flex items-center gap-0.5 rounded-md border border-amber-500/25 bg-background/60 px-1 py-0.5"
            >
              <button
                type="button"
                className="inline-flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
                disabled={isResponding || progress.questionIndex <= 0}
                onClick={handlePrevious}
                aria-label="Previous question"
              >
                <ChevronLeftIcon className="size-3.5" />
              </button>
              <span className="px-1 text-xs font-medium tabular-nums text-muted-foreground">
                {progress.questionIndex + 1} of {totalQuestions}
              </span>
              <button
                type="button"
                className="inline-flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
                disabled={isResponding || progress.isLastQuestion}
                onClick={handleNextStep}
                aria-label="Next question"
              >
                <ChevronRightIcon className="size-3.5" />
              </button>
            </div>
          ) : null}
          {onToggleCollapsed ? (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              onClick={() => {
                clearAutoAdvance();
                onToggleCollapsed();
              }}
              aria-label="Collapse questions"
              title="Collapse questions"
            >
              <ChevronDownIcon className="size-3.5" />
            </Button>
          ) : null}
          {onClose || onToggleCollapsed ? (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              disabled={isResponding && canCancel}
              onClick={handleCloseAction}
              aria-label={canCancel ? "Cancel questions" : "Close questions"}
              title={canCancel ? "Cancel and dismiss questions" : "Collapse questions"}
            >
              <XIcon className="size-3.5" />
            </Button>
          ) : null}
        </div>
      </div>

      <p className="mt-2 text-sm font-medium text-foreground">{activeQuestion.question}</p>
      {activeQuestion.multiSelect ? (
        <p className="mt-1 text-xs text-muted-foreground">Select one or more options.</p>
      ) : null}

      {activeQuestion.options.length > 0 ? (
        <div className="mt-3 space-y-1.5">
          {activeQuestion.options.map((option, index) => {
            const isOptimisticallySelected =
              optimisticSingleSelect?.questionId === activeQuestion.id &&
              optimisticSingleSelect.optionLabel === option.label;
            const isSelected =
              isOptimisticallySelected ||
              (!customAnswerActive && progress.selectedOptionLabels.includes(option.label));
            const recommended = isRecommendedUserInputOption(option);
            const displayLabel = recommended ? formatUserInputOptionLabel(option) : option.label;
            const shortcutKey = index < 9 ? index + 1 : null;
            return (
              <button
                key={`${activeQuestion.id}:${option.label}`}
                type="button"
                disabled={isResponding}
                onClick={() => {
                  selectOption(activeQuestion, option.label);
                }}
                className={cn(
                  "group flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left outline-none transition-all duration-150 focus-visible:border-amber-500/60 focus-visible:ring-1 focus-visible:ring-amber-500/35",
                  isSelected
                    ? "border-amber-500/50 bg-amber-500/12 text-foreground"
                    : "border-border/60 bg-background/70 text-foreground hover:border-amber-500/35 hover:bg-background",
                  isResponding ? "cursor-not-allowed opacity-50" : "cursor-pointer",
                )}
              >
                {shortcutKey !== null ? (
                  <kbd
                    className={cn(
                      "flex size-5 shrink-0 items-center justify-center rounded border text-xs font-medium tabular-nums transition-colors duration-150",
                      isSelected
                        ? "border-amber-500/45 bg-amber-500/15 text-amber-900 dark:text-amber-200"
                        : "border-border/60 bg-muted/40 text-muted-foreground group-hover:border-amber-500/35",
                    )}
                  >
                    {shortcutKey}
                  </kbd>
                ) : null}
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-medium">{displayLabel}</span>
                    {recommended ? (
                      <span
                        data-pending-user-input-recommended="true"
                        className="rounded border border-amber-500/35 bg-amber-500/15 px-1.5 py-0.25 text-xs font-medium text-amber-900 dark:text-amber-200"
                      >
                        Recommended
                      </span>
                    ) : null}
                  </div>
                  {option.description && option.description !== option.label ? (
                    <span className="text-xs text-muted-foreground">{option.description}</span>
                  ) : null}
                </div>
                {isSelected ? (
                  <CheckIcon className="size-3.5 shrink-0 text-amber-700 dark:text-amber-300" />
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="mt-3">
        <input
          type={activeQuestion.isSecret ? "password" : "text"}
          autoComplete={activeQuestion.isSecret ? "off" : undefined}
          data-pending-user-input-free-text="true"
          value={progress.customAnswer}
          disabled={isResponding}
          onChange={(event) => {
            clearAutoAdvance();
            onChangeCustomAnswer?.(activeQuestion.id, event.target.value);
          }}
          onKeyDown={handleCustomKeyDown}
          placeholder={
            activeQuestion.options.length === 0
              ? "Type your answer..."
              : "Type your answer, or choose an option above..."
          }
          aria-label="Type your answer"
          className="w-full rounded-lg border border-border/70 bg-background/85 px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground outline-none transition-colors focus:border-amber-500/55 focus:ring-1 focus:ring-amber-500/30 disabled:cursor-not-allowed disabled:opacity-50"
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          {progress.questionIndex > 0 && (onPreviousQuestion || onSelectQuestionIndex) ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={isResponding}
              onClick={handlePrevious}
            >
              Back
            </Button>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {onSkipAndSubmit &&
          !progress.isComplete &&
          (canSkipAll || progress.answeredQuestionCount > 0) ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!canSkipSubmit}
              title={environmentUnavailableReason ?? undefined}
              onClick={() => {
                clearAutoAdvance();
                onSkipAndSubmit();
              }}
            >
              Skip and submit
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            disabled={!canSubmitOrNext}
            title={submitBlockedReason ?? undefined}
            onClick={() => {
              clearAutoAdvance();
              onAdvance();
            }}
          >
            {isResponding ? "Submitting..." : progress.isLastQuestion ? "Submit" : "Next"}
          </Button>
        </div>
      </div>
    </div>
  );
});
