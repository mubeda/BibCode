import { CheckIcon, CopyIcon, WrapTextIcon } from "lucide-react";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { getClientSettings } from "../../hooks/useSettings";
import {
  hasSpecificPierreIconForFileName,
  syntheticFileNameForLanguageId,
} from "../../pierre-icons";
import { PierreEntryIcon } from "../chat/PierreEntryIcon";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { reportMarkdownActionFailure } from "./markdownActionFailure";

export function readInitialWordWrapSetting(): boolean {
  return getClientSettings().wordWrap;
}

/**
 * Filename titles render icon + text; language-only titles render just the
 * icon (redundant next to its own name) and fall back to the language text
 * when no specific icon exists or it fails to load.
 */
function MarkdownCodeBlockTitleContent({
  fenceTitle,
  language,
  theme,
}: {
  fenceTitle: string | null;
  language: string;
  theme: "light" | "dark";
}) {
  if (fenceTitle) {
    return (
      <>
        <PierreEntryIcon pathValue={fenceTitle} kind="file" theme={theme} className="size-3.5" />
        <span className="truncate">{fenceTitle}</span>
      </>
    );
  }

  const fileName = syntheticFileNameForLanguageId(language);
  if (!hasSpecificPierreIconForFileName(fileName)) {
    return <span className="truncate">{language}</span>;
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex shrink-0 rounded-sm" aria-label={`Language: ${language}`} />
        }
      >
        <PierreEntryIcon pathValue={fileName} kind="file" theme={theme} className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">{language}</TooltipPopup>
    </Tooltip>
  );
}

interface MarkdownCodeBlockState {
  readonly code: string;
  readonly language: string;
  readonly fenceTitle: string | null;
  readonly wrapped: boolean;
  readonly toggleWrapped: () => void;
}

const MarkdownCodeBlockContext = createContext<MarkdownCodeBlockState | null>(null);

function useMarkdownCodeBlock(): MarkdownCodeBlockState {
  const state = use(MarkdownCodeBlockContext);
  if (!state) throw new Error("Code block actions render only inside MarkdownCodeBlock.");
  return state;
}

/** The header button that wraps the block's source lines. */
export function MarkdownCodeBlockWrapAction() {
  const { wrapped, toggleWrapped } = useMarkdownCodeBlock();
  const wrapLabel = wrapped ? "Disable line wrap" : "Wrap lines";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="chat-markdown-chrome-action"
            aria-pressed={wrapped}
            onClick={toggleWrapped}
            aria-label={wrapLabel}
          />
        }
      >
        <WrapTextIcon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">{wrapLabel}</TooltipPopup>
    </Tooltip>
  );
}

/** The header button that copies the block's source. */
export function MarkdownCodeBlockCopyAction() {
  const { code, language, fenceTitle } = useMarkdownCodeBlock();
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyLabel = copied ? "Copied" : "Copy code";

  const handleCopy = useCallback(() => {
    if (typeof navigator === "undefined" || navigator.clipboard == null) {
      return;
    }
    void navigator.clipboard
      .writeText(code)
      .then(() => {
        if (copiedTimerRef.current != null) {
          clearTimeout(copiedTimerRef.current);
        }
        setCopied(true);
        copiedTimerRef.current = setTimeout(() => {
          setCopied(false);
          copiedTimerRef.current = null;
        }, 1200);
      })
      .catch((cause) => {
        reportMarkdownActionFailure(
          {
            operation: "copy-code-block",
            language,
            ...(fenceTitle ? { fenceTitle } : {}),
          },
          cause,
        );
      });
  }, [code, fenceTitle, language]);

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    },
    [],
  );

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="chat-markdown-chrome-action"
            onClick={handleCopy}
            aria-label={copyLabel}
          />
        }
      >
        {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
      </TooltipTrigger>
      <TooltipPopup side="top">{copyLabel}</TooltipPopup>
    </Tooltip>
  );
}

const DEFAULT_CODE_BLOCK_ACTIONS = (
  <>
    <MarkdownCodeBlockWrapAction />
    <MarkdownCodeBlockCopyAction />
  </>
);

/**
 * The code-block card: a header with the language or file title and its actions, then the
 * block's content. `actions` replaces the default Wrap and Copy buttons; the action
 * components read the block's source and wrap state from it.
 */
export function MarkdownCodeBlock({
  code,
  language,
  fenceTitle,
  theme,
  actions = DEFAULT_CODE_BLOCK_ACTIONS,
  children,
}: {
  code: string;
  language: string;
  fenceTitle: string | null;
  theme: "light" | "dark";
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [wrapped, setWrapped] = useState(readInitialWordWrapSetting);
  const toggleWrapped = useCallback(() => setWrapped((value) => !value), []);
  const state = useMemo(
    () => ({ code, language, fenceTitle, wrapped, toggleWrapped }),
    [code, fenceTitle, language, toggleWrapped, wrapped],
  );

  return (
    <div
      className="chat-markdown-codeblock leading-snug"
      data-language={language}
      data-wrap={wrapped ? "true" : "false"}
    >
      <MarkdownCodeBlockContext value={state}>
        <div className="chat-markdown-codeblock-header select-none" data-find-ignore="">
          <span className="chat-markdown-codeblock-title">
            <MarkdownCodeBlockTitleContent
              fenceTitle={fenceTitle}
              language={language}
              theme={theme}
            />
          </span>
          <span className="flex items-center gap-0.5">{actions}</span>
        </div>
      </MarkdownCodeBlockContext>
      {children}
    </div>
  );
}
