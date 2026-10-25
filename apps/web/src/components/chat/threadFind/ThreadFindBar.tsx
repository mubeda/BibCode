import type { ScopedThreadRef } from "@bibcode/contracts";
import { ChevronDownIcon, ChevronUpIcon, SearchIcon, XIcon } from "lucide-react";
import {
  memo,
  useEffect,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { isMacPlatform } from "~/lib/platform";
import { useThreadFindLoadState } from "~/state/threads";
import { Button } from "../../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { MAX_FIND_QUERY_LENGTH } from "./threadFindText";
import { useThreadFind, type ThreadFindStatus, type UseThreadFindOptions } from "./useThreadFind";

/** The visible status: the count beside the input, or a sentence below it. */
export function describeThreadFindStatus(status: ThreadFindStatus): {
  readonly count: string | null;
  readonly message: string | null;
  /** What a screen reader hears. */
  readonly announcement: string;
} {
  const staleNote = " · may be out of date";
  switch (status.kind) {
    case "idle":
      return { count: null, message: null, announcement: "" };
    case "loading":
      return { count: null, message: "Loading thread…", announcement: "Loading thread" };
    case "unavailable":
      return {
        count: null,
        message: "This thread could not be loaded",
        announcement: "This thread could not be loaded",
      };
    case "searching":
      return { count: null, message: "Searching…", announcement: "Searching" };
    case "none": {
      const message = `No results in messages, plans, or commands${status.stale ? staleNote : ""}`;
      return { count: null, message, announcement: message };
    }
    case "match":
      return {
        count: `${status.position}/${status.total}`,
        // The copy held from before the connection changed.
        message: status.stale ? "May be out of date" : null,
        announcement: `${status.position} of ${status.total} matches${status.stale ? ", may be out of date" : ""}`,
      };
  }
}

const ANNOUNCEMENT_DELAY_MS = 400;

/** The live region's text, held back while it keeps changing, as when stepping quickly. */
function useThrottledAnnouncement(text: string): string {
  const [announced, setAnnounced] = useState(text);
  useEffect(() => {
    const timer = setTimeout(() => setAnnounced(text), ANNOUNCEMENT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text]);
  return announced;
}

function isModKey(event: ReactKeyboardEvent): boolean {
  return isMacPlatform(navigator.platform) ? event.metaKey : event.ctrlKey;
}

export interface ThreadFindBarProps {
  readonly query: string;
  readonly status: ThreadFindStatus;
  /** The input, as a callback ref, so the controller can focus it. */
  readonly attachInput: (input: HTMLInputElement | null) => void;
  readonly onQueryChange: (query: string, composing: boolean) => void;
  /** Enter and Shift+Enter in the input. */
  readonly onSubmit: (direction: "next" | "previous") => void;
  readonly onStep: (direction: "next" | "previous") => void;
  readonly onClose: () => void;
}

/** The find bar: a compact overlay at the top of the timeline column. */
export function ThreadFindBar({
  query,
  status,
  attachInput,
  onQueryChange,
  onSubmit,
  onStep,
  onClose,
}: ThreadFindBarProps) {
  const { count, message, announcement } = describeThreadFindStatus(status);
  const announced = useThrottledAnnouncement(announcement);
  const canStep = status.kind === "match";
  const mac = isMacPlatform(navigator.platform);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    const step = event.shiftKey ? "previous" : "next";
    if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      onSubmit(step);
      return;
    }
    if (
      event.key === "F3" ||
      (event.key.toLowerCase() === "g" && isModKey(event) && !event.altKey)
    ) {
      event.preventDefault();
      event.stopPropagation();
      onStep(step);
    }
  };

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    onQueryChange(event.target.value, (event.nativeEvent as InputEvent).isComposing === true);
  };

  return (
    <div
      role="search"
      aria-label="Find in thread"
      className="pointer-events-auto absolute top-2 right-3 left-3 z-30 flex flex-col rounded-lg border bg-popover not-dark:bg-clip-padding text-popover-foreground shadow-lg/5 focus-within:border-ring/60 sm:left-auto sm:w-88"
      data-thread-find-bar=""
      onKeyDown={handleKeyDown}
    >
      <div className="flex items-center gap-1 p-1">
        <SearchIcon className="ms-1.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <input
          ref={attachInput}
          type="text"
          value={query}
          maxLength={MAX_FIND_QUERY_LENGTH}
          placeholder="Find in thread"
          aria-label="Find in thread"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          className="h-7 min-w-0 flex-1 bg-transparent px-1 text-sm text-foreground outline-none placeholder:text-muted-foreground"
          onChange={handleChange}
          onCompositionEnd={(event) => onQueryChange(event.currentTarget.value, false)}
        />
        {count ? (
          <span className="shrink-0 px-1 text-xs tabular-nums text-muted-foreground" aria-hidden>
            {count}
          </span>
        ) : null}
        <span className="sr-only" aria-live="polite">
          {announced}
        </span>
        <FindBarButton
          label="Previous match"
          shortcut={mac ? "⇧↩ or ⇧⌘G" : "Shift+Enter or Shift+F3"}
          disabled={!canStep}
          onClick={() => onStep("previous")}
        >
          <ChevronUpIcon />
        </FindBarButton>
        <FindBarButton
          label="Next match"
          shortcut={mac ? "↩ or ⌘G" : "Enter or F3"}
          disabled={!canStep}
          onClick={() => onStep("next")}
        >
          <ChevronDownIcon />
        </FindBarButton>
        <FindBarButton label="Close" shortcut="Esc" disabled={false} onClick={onClose}>
          <XIcon />
        </FindBarButton>
      </div>
      {message ? (
        <p className="px-2.5 pb-1.5 text-xs text-muted-foreground" aria-hidden>
          {message}
        </p>
      ) : null}
    </div>
  );
}

function FindBarButton({
  label,
  shortcut,
  disabled,
  onClick,
  children,
}: {
  label: string;
  shortcut: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {label} <span className="text-muted-foreground">{shortcut}</span>
      </TooltipPopup>
    </Tooltip>
  );
}

export interface ThreadFindProps extends Omit<UseThreadFindOptions, "loadState"> {
  /** The server thread whose load state find reports; null for a draft. */
  readonly threadRef: ScopedThreadRef | null;
}

/** The controller and its bar for one timeline; renders nothing while find is closed. */
export const ThreadFind = memo(function ThreadFind({ threadRef, ...options }: ThreadFindProps) {
  const loadState = useThreadFindLoadState(threadRef);
  const controller = useThreadFind({ ...options, loadState });
  return controller.isOpen ? (
    <ThreadFindBar
      query={controller.query}
      status={controller.status}
      attachInput={controller.attachInput}
      onQueryChange={controller.setQuery}
      onSubmit={controller.submit}
      onStep={controller.step}
      onClose={controller.close}
    />
  ) : null;
});
