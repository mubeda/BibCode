import { memo, type PointerEventHandler, type ReactElement } from "react";
import { ChevronDownIcon, ChevronLeftIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface PendingActionState {
  questionIndex: number;
  isLastQuestion: boolean;
  canAdvance: boolean;
  isResponding: boolean;
  isComplete: boolean;
}

interface ComposerPrimaryActionsProps {
  compact: boolean;
  pendingAction: PendingActionState | null;
  isRunning: boolean;
  canCancelPendingSend?: boolean;
  showPlanFollowUpPrompt: boolean;
  promptHasText: boolean;
  isSendBusy: boolean;
  isConnecting: boolean;
  isEnvironmentUnavailable: boolean;
  /** What the composer banner calls the unavailable environment's state, e.g. "Laptop: Offline". */
  environmentUnavailableReason?: string | null;
  sendBlockedReason?: string | null;
  isPreparingWorktree: boolean;
  hasSendableContent: boolean;
  preserveComposerFocusOnPointerDown?: boolean;
  onPreviousPendingQuestion: () => void;
  onInterrupt: () => void;
  onImplementPlanInNewThread: () => void;
}

export const formatPendingPrimaryActionLabel = (input: {
  compact: boolean;
  isLastQuestion: boolean;
  isResponding: boolean;
  questionIndex: number;
}) => {
  if (input.isResponding) {
    return "Submitting...";
  }
  if (input.compact) {
    return input.isLastQuestion ? "Submit" : "Next";
  }
  if (!input.isLastQuestion) {
    return "Next question";
  }
  return input.questionIndex > 0 ? "Submit answers" : "Submit answer";
};

/** The accessible name and tooltip of an action that cannot run, e.g. "Send unavailable. Laptop: Offline". */
export function formatUnavailableActionLabel(action: string, reason: string): string {
  return `${action} unavailable. ${reason}`;
}

/**
 * Gives a disabled action its reason as a tooltip. A disabled button gets no pointer or focus
 * events, so a focusable wrapper carries the tooltip; the name stays on the button alone.
 */
function UnavailableActionTooltip({
  label,
  children,
}: {
  label: string | null;
  children: ReactElement;
}) {
  if (label === null) return children;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex" tabIndex={0}>
            {children}
          </span>
        }
      />
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

const preventPointerFocus: PointerEventHandler<HTMLElement> = (event) => {
  event.preventDefault();
};

export const ComposerPrimaryActions = memo(function ComposerPrimaryActions({
  compact,
  pendingAction,
  isRunning,
  canCancelPendingSend = false,
  showPlanFollowUpPrompt,
  promptHasText,
  isSendBusy,
  isConnecting,
  isEnvironmentUnavailable,
  environmentUnavailableReason = null,
  sendBlockedReason = null,
  isPreparingWorktree,
  hasSendableContent,
  preserveComposerFocusOnPointerDown = false,
  onPreviousPendingQuestion,
  onInterrupt,
  onImplementPlanInNewThread,
}: ComposerPrimaryActionsProps) {
  const pointerFocusProps = preserveComposerFocusOnPointerDown
    ? { onPointerDown: preventPointerFocus }
    : undefined;
  // A provider binding conflict keeps precedence over the environment's state.
  const environmentReason = isEnvironmentUnavailable
    ? (environmentUnavailableReason ?? "Environment disconnected")
    : null;
  const blockedReason = sendBlockedReason ?? environmentReason;

  if (pendingAction) {
    // Moving to the next question stays local; only the final answer needs the environment.
    const pendingBlockedReason =
      sendBlockedReason ?? (pendingAction.isLastQuestion ? environmentReason : null);
    const pendingLabel = formatPendingPrimaryActionLabel({
      compact,
      isLastQuestion: pendingAction.isLastQuestion,
      isResponding: pendingAction.isResponding,
      questionIndex: pendingAction.questionIndex,
    });
    const pendingUnavailableLabel = pendingBlockedReason
      ? formatUnavailableActionLabel(pendingLabel, pendingBlockedReason)
      : null;
    return (
      <div className={cn("flex items-center justify-end", compact ? "gap-1.5" : "gap-2")}>
        {pendingAction.questionIndex > 0 ? (
          compact ? (
            <Button
              size="icon-sm"
              variant="outline"
              className="rounded-full"
              {...pointerFocusProps}
              onClick={onPreviousPendingQuestion}
              disabled={pendingAction.isResponding}
              aria-label="Previous question"
            >
              <ChevronLeftIcon className="size-3.5" />
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="rounded-full"
              {...pointerFocusProps}
              onClick={onPreviousPendingQuestion}
              disabled={pendingAction.isResponding}
            >
              Previous
            </Button>
          )
        ) : null}
        <UnavailableActionTooltip label={pendingUnavailableLabel}>
          <Button
            type="submit"
            size="sm"
            className={cn("rounded-full", compact ? "px-3" : "px-4")}
            {...pointerFocusProps}
            {...(pendingUnavailableLabel ? { "aria-label": pendingUnavailableLabel } : {})}
            disabled={
              pendingBlockedReason !== null ||
              pendingAction.isResponding ||
              (pendingAction.isLastQuestion ? !pendingAction.isComplete : !pendingAction.canAdvance)
            }
          >
            {pendingLabel}
          </Button>
        </UnavailableActionTooltip>
      </div>
    );
  }

  if (isRunning || canCancelPendingSend) {
    const interruptLabel = isRunning ? "Stop generation" : "Cancel queued message";
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="flex size-8 cursor-pointer items-center justify-center rounded-full bg-destructive/90 text-white shadow-xs shadow-destructive/24 inset-shadow-[0_1px_--theme(--color-white/16%)] transition-all duration-150 hover:bg-destructive hover:scale-105 active:inset-shadow-[0_1px_--theme(--color-black/8%)] active:shadow-none sm:h-8 sm:w-8"
              {...pointerFocusProps}
              onClick={onInterrupt}
              aria-label={interruptLabel}
            />
          }
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
            <rect x="2" y="2" width="8" height="8" rx="1.5" />
          </svg>
        </TooltipTrigger>
        <TooltipPopup side="top">{interruptLabel}</TooltipPopup>
      </Tooltip>
    );
  }

  if (showPlanFollowUpPrompt) {
    const followUpUnavailableLabel = (action: string) =>
      blockedReason ? formatUnavailableActionLabel(action, blockedReason) : null;
    if (promptHasText) {
      const refineUnavailableLabel = followUpUnavailableLabel("Refine");
      return (
        <UnavailableActionTooltip label={refineUnavailableLabel}>
          <Button
            type="submit"
            size="sm"
            className={cn("rounded-full", compact ? "h-9 px-3 sm:h-8" : "h-9 px-4 sm:h-8")}
            {...pointerFocusProps}
            {...(refineUnavailableLabel ? { "aria-label": refineUnavailableLabel } : {})}
            disabled={blockedReason !== null || isSendBusy || isConnecting}
          >
            {isConnecting || isSendBusy ? "Sending..." : "Refine"}
          </Button>
        </UnavailableActionTooltip>
      );
    }
    const implementUnavailableLabel = followUpUnavailableLabel("Implement");

    return (
      <div data-chat-composer-implement-actions="true" className="flex items-center justify-end">
        <UnavailableActionTooltip label={implementUnavailableLabel}>
          <Button
            type="submit"
            size="sm"
            className="h-9 rounded-l-full rounded-r-none px-4 sm:h-8"
            {...pointerFocusProps}
            {...(implementUnavailableLabel ? { "aria-label": implementUnavailableLabel } : {})}
            disabled={blockedReason !== null || isSendBusy || isConnecting}
          >
            {isConnecting || isSendBusy ? "Sending..." : "Implement"}
          </Button>
        </UnavailableActionTooltip>
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="sm"
                variant="default"
                className="h-9 rounded-l-none rounded-r-full border-l-white/12 px-2 sm:h-8"
                aria-label={
                  blockedReason
                    ? formatUnavailableActionLabel("Implementation actions", blockedReason)
                    : "Implementation actions"
                }
                {...pointerFocusProps}
                disabled={blockedReason !== null || isSendBusy || isConnecting}
              />
            }
          >
            <ChevronDownIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end" side="top">
            <MenuItem
              disabled={blockedReason !== null || isSendBusy || isConnecting}
              onClick={() => void onImplementPlanInNewThread()}
            >
              Implement in a new thread
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    );
  }

  const sendLabel = blockedReason
    ? formatUnavailableActionLabel("Send", blockedReason)
    : isConnecting
      ? "Connecting"
      : isPreparingWorktree
        ? "Preparing worktree"
        : isSendBusy
          ? "Sending"
          : "Send message";
  const isSendDisabled =
    blockedReason !== null || isSendBusy || isConnecting || !hasSendableContent;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          // The wrapper only lets a disabled Send show its tooltip; the name is the button's.
          <span className="inline-flex" tabIndex={isSendDisabled ? 0 : undefined}>
            <button
              type="submit"
              className="flex h-9 w-9 enabled:cursor-pointer items-center justify-center rounded-full bg-primary/90 text-primary-foreground shadow-xs enabled:shadow-primary/24 enabled:inset-shadow-[0_1px_--theme(--color-white/16%)] transition-all duration-150 hover:bg-primary hover:scale-105 active:inset-shadow-[0_1px_--theme(--color-black/8%)] active:shadow-none disabled:pointer-events-none disabled:opacity-30 disabled:shadow-none disabled:hover:scale-100 sm:h-8 sm:w-8"
              {...pointerFocusProps}
              disabled={isSendDisabled}
              aria-label={sendLabel}
            >
              {isConnecting || isSendBusy ? (
                <Spinner className="size-3.5" aria-hidden="true" />
              ) : (
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <path
                    d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </button>
          </span>
        }
      />
      <TooltipPopup side="top">{sendLabel}</TooltipPopup>
    </Tooltip>
  );
});
