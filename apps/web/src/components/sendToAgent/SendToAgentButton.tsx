/**
 * The composer's Send to agent control: a menu of the five actions, each listing the agents of
 * this project that can receive it (with the reason when one cannot) and the providers a new
 * panel can start with. Choosing an agent opens the preview. Both the menu and the preview
 * mount their lists only while open.
 */
import type { DefaultAgentSelection, SendRequestsSendInput, ThreadId } from "@bibcode/contracts";
import { ForwardIcon } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";

import { randomUUID } from "~/lib/utils";
import type { SendOutcome } from "~/state/sendRequests";
import { formatUnavailableActionLabel } from "../chat/ComposerPrimaryActions";
import type { AgentRow } from "../sidebar/agentsSection.logic";
import { Button } from "../ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { hintTargetWarning, type OutOfTokensHint } from "./outOfTokens.logic";
import { SendToAgentPreview } from "./SendToAgentPreview";
import {
  buildSendTargets,
  resolveActionAvailability,
  sendChoiceKey,
  SEND_TO_AGENT_SERVER_UPDATE_REASON,
  SEND_TO_AGENT_ACTIONS,
  submitSendChoice,
  type NewPanelProvider,
  type PreviewContent,
  type SendChoice,
  type SendTargetEntry,
  type SendToAgentSource,
  sendToAgentControlLabel,
} from "./sendToAgent.logic";

/** What the open menu needs and the closed button must not subscribe to. */
export interface LiveSendInputs {
  source: SendToAgentSource;
  rows: ReadonlyArray<AgentRow>;
  /** The out-of-tokens hint of an agent, from data read only while the menu is open. */
  hintFor?: (row: AgentRow) => OutOfTokensHint | null;
  /** Whether a terminal row can be notified, from terminal state read only while open. */
  canNotifyTerminal?: (row: AgentRow) => boolean;
}

export interface SendToAgentButtonProps {
  source: SendToAgentSource;
  serverSupported: boolean;
  rows: ReadonlyArray<AgentRow>;
  /**
   * Supplies the live `source` and `rows` to the open menu only, by rendering `render` inside a
   * component that reads them. Without it the menu uses `source` and `rows` as given. Keep it
   * stable, or the button re-renders with it.
   */
  renderLive?: (render: (live: LiveSendInputs) => ReactNode) => ReactNode;
  projectRootByProjectId: ReadonlyMap<string, string>;
  newPanelProvidersFor: (action: SendChoice["action"]) => ReadonlyArray<NewPanelProvider>;
  canNotifyTerminal: (row: AgentRow) => boolean;
  /** The out-of-tokens hint of an agent; `renderLive` can supply a live one instead. */
  hintFor?: (row: AgentRow) => OutOfTokensHint | null;
  /** Called when an agent is chosen, before the preview opens. */
  onChoose?: (choice: SendChoice) => void;
  /** What the preview shows for a choice; an action without content opens no preview. */
  previewContentFor?: (choice: SendChoice) => PreviewContent | null;
  send?: (input: SendRequestsSendInput) => Promise<SendOutcome>;
  createPanel?: (selection: DefaultAgentSelection) => Promise<ThreadId | null>;
  /** Brings a panel `createPanel` made inactive forward once its request was sent. */
  revealPanel?: (panel: ThreadId) => void;
  /** Where focus goes when the preview closes; the trigger by default. */
  finalFocus?: RefObject<HTMLElement | null>;
  /** Answers to this source's requests that wait for the person, named on the control. */
  waitingAnswers?: number;
  /** Paints the trigger in the primary button color, for a host where it is the main action. */
  prominent?: boolean;
  /** Opens the menu each time it grows, so a host can bring the person to the control. */
  openSignal?: number;
  newId?: () => string;
}

const renderGiven =
  (props: LiveSendInputs): NonNullable<SendToAgentButtonProps["renderLive"]> =>
  (render) =>
    render(props);

const defaultNewId = randomUUID;
const noPanel = () => Promise.resolve(null);
const noSend = () =>
  Promise.resolve<SendOutcome>({ kind: "failed", reason: "invalid", message: "Cannot send." });

function TriggerButton(
  props: ComponentProps<typeof Button> & {
    readonly unavailable?: boolean;
    readonly waitingAnswers?: number;
    readonly prominent?: boolean;
  },
): ReactElement {
  const { unavailable, waitingAnswers = 0, prominent = false, ...rest } = props;
  return (
    <Button
      variant={prominent ? "default" : "ghost"}
      size="icon-sm"
      type="button"
      aria-label={sendToAgentControlLabel(waitingAnswers)}
      className={waitingAnswers > 0 ? "relative" : undefined}
      {...(unavailable ? { "aria-disabled": "true" as const } : {})}
      {...rest}
    >
      <ForwardIcon />
      {waitingAnswers > 0 ? (
        <span
          aria-hidden="true"
          data-waiting-answers={waitingAnswers}
          className={`absolute -top-0.5 -right-0.5 size-2 rounded-full ${
            prominent ? "bg-primary-foreground ring-1 ring-primary" : "bg-primary"
          }`}
        />
      ) : null}
    </Button>
  );
}

export const SendToAgentButton = memo(function SendToAgentButton(props: SendToAgentButtonProps) {
  const { serverSupported, onChoose, previewContentFor } = props;
  // The hint the chosen agent carried in the list, for the preview's warning.
  const [picked, setPicked] = useState<{ choice: SendChoice; hint: OutOfTokensHint | null } | null>(
    null,
  );
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // Adjusted during render: a grown signal opens the menu without an extra effect pass.
  const { openSignal = 0 } = props;
  const [seenSignal, setSeenSignal] = useState(openSignal);
  if (openSignal !== seenSignal) {
    setSeenSignal(openSignal);
    if (openSignal > seenSignal) setMenuOpen(true);
  }

  const choose = useCallback(
    (next: SendChoice, hint: OutOfTokensHint | null) => {
      onChoose?.(next);
      if (previewContentFor !== undefined) setPicked({ choice: next, hint });
    },
    [onChoose, previewContentFor],
  );
  const closePreview = useCallback(() => setPicked(null), []);
  const pickAnother = useCallback(() => {
    setPicked(null);
    setMenuOpen(true);
  }, []);

  if (!serverSupported) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={<TriggerButton unavailable prominent={props.prominent ?? false} />}
        />
        <TooltipPopup side="top">{SEND_TO_AGENT_SERVER_UPDATE_REASON}</TooltipPopup>
      </Tooltip>
    );
  }
  return (
    <>
      <Menu open={menuOpen} onOpenChange={setMenuOpen}>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={
                  <TriggerButton
                    ref={triggerRef}
                    waitingAnswers={props.waitingAnswers ?? 0}
                    prominent={props.prominent ?? false}
                  />
                }
              />
            }
          />
          <TooltipPopup side="top">Send to agent</TooltipPopup>
        </Tooltip>
        <MenuPopup side="top" align="end" className="w-72 max-w-[calc(100vw-2rem)]">
          {menuOpen
            ? (props.renderLive ?? renderGiven(props))((live) => (
                <ActionList
                  {...props}
                  source={live.source}
                  rows={live.rows}
                  {...(live.hintFor === undefined ? {} : { hintFor: live.hintFor })}
                  {...(live.canNotifyTerminal === undefined
                    ? {}
                    : { canNotifyTerminal: live.canNotifyTerminal })}
                  onChoose={choose}
                />
              ))
            : null}
        </MenuPopup>
      </Menu>
      {picked !== null && previewContentFor !== undefined ? (
        <PreviewHost
          choice={picked.choice}
          hint={picked.hint}
          previewContentFor={previewContentFor}
          finalFocus={props.finalFocus ?? triggerRef}
          newPanelProviders={props.newPanelProvidersFor(picked.choice.action)}
          send={props.send ?? noSend}
          createPanel={props.createPanel ?? noPanel}
          revealPanel={props.revealPanel}
          newId={props.newId ?? defaultNewId}
          onClose={closePreview}
          onPickAnother={pickAnother}
        />
      ) : null}
    </>
  );
});

function PreviewHost(props: {
  choice: SendChoice;
  hint: OutOfTokensHint | null;
  previewContentFor: NonNullable<SendToAgentButtonProps["previewContentFor"]>;
  finalFocus: RefObject<HTMLElement | null>;
  newPanelProviders: ReadonlyArray<NewPanelProvider>;
  send: NonNullable<SendToAgentButtonProps["send"]>;
  createPanel: NonNullable<SendToAgentButtonProps["createPanel"]>;
  revealPanel: SendToAgentButtonProps["revealPanel"];
  newId: () => string;
  onClose: () => void;
  onPickAnother: () => void;
}) {
  const { choice, previewContentFor, newPanelProviders, send, createPanel, newId, revealPanel } =
    props;
  const content = useMemo(() => previewContentFor(choice), [choice, previewContentFor]);
  const target = useMemo(() => {
    // The picked agent only supplies text: the request goes to this panel's own agent.
    if (choice.action === "take-over") {
      return { title: "this agent", providerLabel: null, newPanel: false };
    }
    if (choice.target.kind === "agent") {
      return {
        title: choice.target.row.shell.title,
        providerLabel: choice.target.row.providerLabel,
        newPanel: false,
      };
    }
    const { selection } = choice.target;
    const provider = newPanelProviders.find(
      (entry) =>
        entry.selection.kind === selection.kind &&
        entry.selection.instanceId === selection.instanceId,
    );
    return { title: provider?.label ?? "a new panel", providerLabel: null, newPanel: true };
  }, [choice, newPanelProviders]);
  // This host is the open preview until it unmounts or another choice replaces `choice`.
  const latestChoice = useRef(choice);
  const open = useRef(true);
  useEffect(() => {
    latestChoice.current = choice;
    open.current = true;
    return () => {
      open.current = false;
    };
  }, [choice]);
  const onSend = useCallback(
    (draft: Parameters<NonNullable<PreviewContent["submit"]>>[0]) => {
      const isCurrent = () => open.current && latestChoice.current === choice;
      return content?.submit !== undefined
        ? content.submit(draft, isCurrent)
        : submitSendChoice(
            { send, createPanel, newId, ...(revealPanel === undefined ? {} : { revealPanel }) },
            choice,
            draft,
            isCurrent,
          );
    },
    [choice, content, createPanel, newId, revealPanel, send],
  );
  if (content === null) return null;
  const fromTitle =
    choice.action === "take-over" && choice.target.kind === "agent"
      ? choice.target.row.shell.title
      : choice.source.title;
  // A taken-over agent only supplies text, so whether it can answer does not matter.
  const hintWarning =
    props.hint === null || choice.action === "take-over" ? null : hintTargetWarning(props.hint);
  const warning =
    [content.warning ?? null, hintWarning].filter((part) => part !== null).join(" ") || null;
  return (
    <SendToAgentPreview
      open
      source={{ key: sendChoiceKey(choice), title: fromTitle }}
      action={choice.action}
      target={target}
      leadIn={content.leadIn}
      initialAttachments={content.attachments}
      {...(content.loadAttachments === undefined
        ? {}
        : { loadAttachments: content.loadAttachments })}
      {...(content.loadFailedMessage === undefined
        ? {}
        : { loadFailedMessage: content.loadFailedMessage })}
      {...(content.loadingMessage === undefined ? {} : { loadingMessage: content.loadingMessage })}
      {...(content.extraContent === undefined ? {} : { extraContent: content.extraContent })}
      warning={warning}
      finalFocus={props.finalFocus}
      onClose={props.onClose}
      onSend={onSend}
      onPickAnother={props.onPickAnother}
    />
  );
}

type Choose = (choice: SendChoice, hint: OutOfTokensHint | null) => void;

function ActionList(props: Omit<SendToAgentButtonProps, "onChoose"> & { onChoose: Choose }) {
  return (
    <div data-text-surface="popover">
      {SEND_TO_AGENT_ACTIONS.map(({ action, label }) => {
        const { disabledReason } = resolveActionAvailability({
          source: props.source,
          action,
          serverSupported: props.serverSupported,
        });
        if (disabledReason !== null) {
          return <BlockedItem key={action} name={label} reason={disabledReason} />;
        }
        return (
          <MenuSub key={action}>
            <MenuSubTrigger>{label}</MenuSubTrigger>
            <MenuSubPopup className="w-72 max-w-[calc(100vw-2rem)]">
              <TargetList {...props} action={action} actionLabel={label} />
            </MenuSubPopup>
          </MenuSub>
        );
      })}
    </div>
  );
}

function TargetList(
  props: Omit<SendToAgentButtonProps, "onChoose"> & {
    action: SendChoice["action"];
    actionLabel: string;
    onChoose: Choose;
  },
) {
  const { source, action, rows, projectRootByProjectId, canNotifyTerminal, hintFor } = props;
  const newPanelProviders = props.newPanelProvidersFor(action);
  const entries = useMemo(
    () =>
      buildSendTargets({
        source,
        action,
        rows,
        projectRootByProjectId,
        newPanelProviders,
        canNotifyTerminal,
        ...(hintFor === undefined ? {} : { hintFor }),
      }),
    [action, canNotifyTerminal, hintFor, newPanelProviders, projectRootByProjectId, rows, source],
  );
  if (entries.length === 0) {
    return (
      <p className="px-2 py-1.5 text-muted-foreground text-xs">No other agents in this project</p>
    );
  }
  return (
    <div data-text-surface="popover">
      {entries.map((entry) => (
        <TargetItem
          key={entry.key}
          entry={entry}
          onPick={() => props.onChoose({ source, action, target: entry.target }, entry.hint)}
        />
      ))}
    </div>
  );
}

function BlockedItem(props: { name: string; reason: string }) {
  return (
    <MenuItem
      closeOnClick={false}
      aria-disabled="true"
      aria-label={formatUnavailableActionLabel(props.name, props.reason)}
    >
      <span className="min-w-0 flex-1 truncate opacity-64">{props.name}</span>
      <span className="shrink-0 ps-3 text-muted-foreground text-xs">{props.reason}</span>
    </MenuItem>
  );
}

function TargetItem(props: { entry: SendTargetEntry; onPick: () => void }) {
  const { entry } = props;
  if (entry.disabledReason !== null) {
    return (
      <MenuItem
        closeOnClick={false}
        aria-disabled="true"
        aria-label={formatUnavailableActionLabel(
          entry.hint === null ? entry.title : `${entry.title}, ${entry.hint.text}`,
          entry.disabledReason,
        )}
        className="h-auto items-start"
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate opacity-64">{entry.title}</span>
          {entry.hint === null ? null : (
            <span className="text-muted-foreground text-xs">{entry.hint.text}</span>
          )}
          <span className="text-muted-foreground text-xs">{entry.disabledReason}</span>
        </span>
      </MenuItem>
    );
  }
  return (
    <MenuItem onClick={props.onPick} className={entry.hint === null ? undefined : "h-auto"}>
      {/* The hint is text inside the item, so it is part of the item's accessible name. */}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{entry.title}</span>
        {entry.hint === null ? null : (
          <span className="text-muted-foreground text-xs">{entry.hint.text}</span>
        )}
      </span>
      {entry.providerLabel ? (
        <span className="shrink-0 text-muted-foreground text-xs">{entry.providerLabel}</span>
      ) : null}
      {entry.busy ? <span className="shrink-0 text-muted-foreground text-xs">Busy</span> : null}
    </MenuItem>
  );
}
