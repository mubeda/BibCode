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
} from "./sendToAgent.logic";

/** What the open menu needs and the closed button must not subscribe to. */
export interface LiveSendInputs {
  source: SendToAgentSource;
  rows: ReadonlyArray<AgentRow>;
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
  /** Called when an agent is chosen, before the preview opens. */
  onChoose?: (choice: SendChoice) => void;
  /** What the preview shows for a choice; an action without content opens no preview. */
  previewContentFor?: (choice: SendChoice) => PreviewContent | null;
  send?: (input: SendRequestsSendInput) => Promise<SendOutcome>;
  createPanel?: (selection: DefaultAgentSelection) => Promise<ThreadId | null>;
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
  props: ComponentProps<typeof Button> & { readonly unavailable?: boolean },
): ReactElement {
  const { unavailable, ...rest } = props;
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      type="button"
      aria-label="Send to agent"
      {...(unavailable ? { "aria-disabled": "true" as const } : {})}
      {...rest}
    >
      <ForwardIcon />
    </Button>
  );
}

export const SendToAgentButton = memo(function SendToAgentButton(props: SendToAgentButtonProps) {
  const { serverSupported, onChoose, previewContentFor } = props;
  const [choice, setChoice] = useState<SendChoice | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const choose = useCallback(
    (next: SendChoice) => {
      onChoose?.(next);
      if (previewContentFor !== undefined) setChoice(next);
    },
    [onChoose, previewContentFor],
  );
  const closePreview = useCallback(() => setChoice(null), []);
  const pickAnother = useCallback(() => {
    setChoice(null);
    setMenuOpen(true);
  }, []);

  if (!serverSupported) {
    return (
      <Tooltip>
        <TooltipTrigger render={<TriggerButton unavailable />} />
        <TooltipPopup side="top">{SEND_TO_AGENT_SERVER_UPDATE_REASON}</TooltipPopup>
      </Tooltip>
    );
  }
  return (
    <>
      <Menu open={menuOpen} onOpenChange={setMenuOpen}>
        <Tooltip>
          <TooltipTrigger render={<MenuTrigger render={<TriggerButton ref={triggerRef} />} />} />
          <TooltipPopup side="top">Send to agent</TooltipPopup>
        </Tooltip>
        <MenuPopup side="top" align="end" className="w-72 max-w-[calc(100vw-2rem)]">
          {menuOpen
            ? (props.renderLive ?? renderGiven(props))((live) => (
                <ActionList {...props} source={live.source} rows={live.rows} onChoose={choose} />
              ))
            : null}
        </MenuPopup>
      </Menu>
      {choice !== null && previewContentFor !== undefined ? (
        <PreviewHost
          choice={choice}
          previewContentFor={previewContentFor}
          triggerRef={triggerRef}
          newPanelProviders={props.newPanelProvidersFor(choice.action)}
          send={props.send ?? noSend}
          createPanel={props.createPanel ?? noPanel}
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
  previewContentFor: NonNullable<SendToAgentButtonProps["previewContentFor"]>;
  triggerRef: RefObject<HTMLElement | null>;
  newPanelProviders: ReadonlyArray<NewPanelProvider>;
  send: NonNullable<SendToAgentButtonProps["send"]>;
  createPanel: NonNullable<SendToAgentButtonProps["createPanel"]>;
  newId: () => string;
  onClose: () => void;
  onPickAnother: () => void;
}) {
  const { choice, previewContentFor, newPanelProviders, send, createPanel, newId } = props;
  const content = useMemo(() => previewContentFor(choice), [choice, previewContentFor]);
  const target = useMemo(() => {
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
  const onSend = useCallback(
    (draft: Parameters<NonNullable<PreviewContent["submit"]>>[0]) =>
      content?.submit !== undefined
        ? content.submit(draft)
        : submitSendChoice({ send, createPanel, newId }, choice, draft),
    [choice, content, createPanel, newId, send],
  );
  if (content === null) return null;
  return (
    <SendToAgentPreview
      open
      source={{ key: sendChoiceKey(choice), title: choice.source.title }}
      action={choice.action}
      target={target}
      leadIn={content.leadIn}
      initialAttachments={content.attachments}
      {...(content.extraContent === undefined ? {} : { extraContent: content.extraContent })}
      {...(content.warning === undefined ? {} : { warning: content.warning })}
      finalFocus={props.triggerRef}
      onClose={props.onClose}
      onSend={onSend}
      onPickAnother={props.onPickAnother}
    />
  );
}

function ActionList(props: SendToAgentButtonProps & { onChoose: (choice: SendChoice) => void }) {
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
  props: SendToAgentButtonProps & {
    action: SendChoice["action"];
    actionLabel: string;
    onChoose: (choice: SendChoice) => void;
  },
) {
  const { source, action, rows, projectRootByProjectId, canNotifyTerminal } = props;
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
      }),
    [action, canNotifyTerminal, newPanelProviders, projectRootByProjectId, rows, source],
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
          onPick={() => props.onChoose({ source, action, target: entry.target })}
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
        aria-label={formatUnavailableActionLabel(entry.title, entry.disabledReason)}
        className="h-auto items-start"
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate opacity-64">{entry.title}</span>
          <span className="text-muted-foreground text-xs">{entry.disabledReason}</span>
        </span>
      </MenuItem>
    );
  }
  return (
    <MenuItem onClick={props.onPick}>
      <span className="min-w-0 flex-1 truncate">{entry.title}</span>
      {entry.providerLabel ? (
        <span className="shrink-0 text-muted-foreground text-xs">{entry.providerLabel}</span>
      ) : null}
      {entry.busy ? <span className="shrink-0 text-muted-foreground text-xs">Busy</span> : null}
    </MenuItem>
  );
}
