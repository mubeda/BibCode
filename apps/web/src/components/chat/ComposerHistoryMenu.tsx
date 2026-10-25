/**
 * The composer's History menu: this thread's closed chat panels and, below a separator, the
 * Claude Code sessions run in a terminal in the thread's folder. Both sections mount only while
 * the menu is open, so nothing loads until it opens and closing it aborts the listing.
 */
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@bibcode/client-runtime/state/runtime";
import type {
  AgentSessionHistoryEntry,
  AgentSessionOpenMode,
  AgentSessionThreadListResult,
  EnvironmentId,
  ThreadId,
} from "@bibcode/contracts";
import { useAtomValue } from "@effect/atom-react";
import { HistoryIcon } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";

import { usePrimarySessionState } from "~/environments/primary";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { projectEnvironment } from "~/state/projects";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { closedChatLabel, useClosedChatPanels } from "./ChatHeaderPanelMenu";
import {
  type TerminalSessionAction,
  terminalSessionRow,
  viewOnlyReason,
} from "./ComposerHistoryMenu.logic";

/** A session's existing thread: its panel or sidebar thread opens. */
export interface ImportedSessionThread {
  readonly threadId: ThreadId;
  /** The panel's host, or `null` for a sidebar thread. */
  readonly hostThreadId: ThreadId | null;
  /** Whether the panel is closed; unknown for a thread History did not list. */
  readonly archived?: boolean;
}

export interface ComposerHistoryMenuProps {
  readonly environmentId: EnvironmentId;
  /**
   * The thread History acts for: the composer's own thread, or the host of a chat panel; `null`
   * before the thread exists, when `unavailableReason` says why.
   */
  readonly hostThreadId: ThreadId | null;
  /** Why History can't be used for this thread now, or `null`. */
  readonly unavailableReason: string | null;
  /** The environment's name, for the texts about where sessions come from. */
  readonly environmentLabel: string;
  readonly onReopenChat: (threadId: ThreadId, label: string) => void;
  readonly onOpenImported: (thread: ImportedSessionThread, title: string) => void;
  /** Resolves `true` once the session's panel opened; a failure has been shown when `false`. */
  readonly onContinueSession: (
    sessionId: string,
    mode: AgentSessionOpenMode,
    title: string,
  ) => Promise<boolean>;
}

interface HistoryMenuProps extends ComposerHistoryMenuProps {
  readonly disabledReason: string | null;
  /** The environment is this BiBCode's own server, so its sessions are this machine's. */
  readonly localEnvironment: boolean;
}

/**
 * Reads the granted scopes only for the primary environment: a remote connection keeps no
 * record of them, so its refusal shows in the menu instead.
 */
export const ComposerHistoryMenu = memo(function ComposerHistoryMenu(
  props: ComposerHistoryMenuProps,
) {
  const primary = usePrimaryEnvironmentId() === props.environmentId;
  return primary ? (
    <PrimaryComposerHistoryMenu {...props} />
  ) : (
    <HistoryMenu {...props} localEnvironment={false} disabledReason={props.unavailableReason} />
  );
});

function PrimaryComposerHistoryMenu(props: ComposerHistoryMenuProps) {
  const scopes = usePrimarySessionState().data?.scopes;
  return (
    <HistoryMenu
      {...props}
      localEnvironment
      disabledReason={props.unavailableReason ?? viewOnlyReason(scopes)}
    />
  );
}

/** Takes the props a trigger render merges in. `unavailable` keeps it focusable for its reason. */
function HistoryButton({
  unavailable,
  ...props
}: ComponentProps<typeof Button> & { readonly unavailable?: boolean }): ReactElement {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      type="button"
      aria-label="History"
      {...(unavailable ? { "aria-disabled": "true" as const } : {})}
      {...props}
    >
      <HistoryIcon />
    </Button>
  );
}

function HistoryMenu(props: HistoryMenuProps) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const { hostThreadId } = props;
  const disabledReason = props.disabledReason ?? (hostThreadId === null ? "" : null);
  if (disabledReason !== null || hostThreadId === null) {
    // Focusable, so the reason is reachable from the keyboard too.
    return (
      <Tooltip>
        <TooltipTrigger render={<HistoryButton unavailable />} />
        {disabledReason ? <TooltipPopup side="top">{disabledReason}</TooltipPopup> : null}
      </Tooltip>
    );
  }
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger render={<MenuTrigger render={<HistoryButton />} />} />
        <TooltipPopup side="top">History</TooltipPopup>
      </Tooltip>
      <MenuPopup side="top" align="end" className="w-80 max-w-[calc(100vw-2rem)]">
        <div data-text-surface="popover">
          <ClosedChatsGroup
            environmentId={props.environmentId}
            hostThreadId={hostThreadId}
            onReopen={props.onReopenChat}
          />
          <MenuSeparator />
          <TerminalSessionsSection {...props} hostThreadId={hostThreadId} onOpened={close} />
        </div>
      </MenuPopup>
    </Menu>
  );
}

type TerminalSessionsProps = HistoryMenuProps & {
  readonly hostThreadId: ThreadId;
  /** Closes the menu once a session's panel opened. */
  readonly onOpened: () => void;
};

/**
 * Only a server that advertises `cliSessionHistory` is sent the History methods: an older one
 * answers an unknown method with a defect that breaks the whole RPC session. This thread's
 * closed chats work against any server.
 */
function TerminalSessionsSection(props: TerminalSessionsProps) {
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  if (serverConfig?.environment.capabilities.cliSessionHistory === true) {
    return <TerminalSessionsGroup {...props} />;
  }
  return (
    <MenuGroup>
      <MenuGroupLabel>Claude Code terminal</MenuGroupLabel>
      <HistoryNote>
        {serverConfig
          ? `Update ${props.environmentLabel} to list its terminal sessions here.`
          : "Loading…"}
      </HistoryNote>
    </MenuGroup>
  );
}

function HistoryNote(props: { readonly children: ReactNode }) {
  return <p className="px-2 py-1.5 text-muted-foreground text-xs">{props.children}</p>;
}

function ClosedChatsGroup(props: {
  readonly environmentId: EnvironmentId;
  readonly hostThreadId: ThreadId;
  readonly onReopen: (threadId: ThreadId, label: string) => void;
}) {
  const { closedChats, isLoading, error, refresh } = useClosedChatPanels(
    props.environmentId,
    props.hostThreadId,
  );
  return (
    <MenuGroup>
      <MenuGroupLabel>This thread</MenuGroupLabel>
      {closedChats.map((thread) => {
        const label = closedChatLabel(thread.title);
        return (
          <MenuItem key={thread.id} onClick={() => props.onReopen(thread.id, label)}>
            <span className="min-w-0 flex-1 truncate">{label}</span>
            <span className="shrink-0 ps-3 text-muted-foreground text-xs">
              {formatRelativeTimeLabel(thread.archivedAt)}
            </span>
          </MenuItem>
        );
      })}
      {closedChats.length > 0 ? null : error !== null ? (
        // An empty list here would hide closed chats that exist; offer a retry instead.
        <MenuItem closeOnClick={false} onClick={refresh}>
          <span className="text-muted-foreground text-xs">
            Couldn't load closed chats. Select to retry.
          </span>
        </MenuItem>
      ) : (
        <HistoryNote>{isLoading ? "Loading…" : "No closed chats"}</HistoryNote>
      )}
    </MenuGroup>
  );
}

type TerminalSessionsState =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "ready"; readonly result: AgentSessionThreadListResult };

function failureReason(result: { readonly cause: unknown }): string {
  const error = squashAtomCommandFailure(result as never);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The server did not answer.";
}

function TerminalSessionsGroup(props: TerminalSessionsProps) {
  const listSessions = useAtomCommand(projectEnvironment.listThreadAgentSessions, {
    reportFailure: false,
  });
  const [state, setState] = useState<TerminalSessionsState>({ status: "loading" });
  const [openingSessionId, setOpeningSessionId] = useState<string | null>(null);
  const { environmentId, hostThreadId } = props;

  // The listing in flight, aborted by a newer one and when the menu closes.
  const listingController = useRef<AbortController | null>(null);
  const list = useCallback(() => {
    listingController.current?.abort();
    const controller = new AbortController();
    listingController.current = controller;
    void listSessions(
      { environmentId, input: { threadId: hostThreadId } },
      { signal: controller.signal },
    ).then((result) => {
      if (controller.signal.aborted) return;
      if (result._tag === "Success") {
        setState({ status: "ready", result: result.value });
      } else if (!isAtomCommandInterrupted(result)) {
        setState({ status: "failed", reason: failureReason(result) });
      }
    });
  }, [environmentId, hostThreadId, listSessions]);
  const abortListing = useCallback(() => listingController.current?.abort(), []);

  // Closing the menu unmounts this group, which stops the server's listing.
  useEffect(() => {
    list();
    return abortListing;
  }, [abortListing, list]);

  const reload = useCallback(() => {
    setState({ status: "loading" });
    list();
  }, [list]);

  const { onContinueSession, onOpenImported, onOpened } = props;
  const choose = useCallback(
    async (entry: AgentSessionHistoryEntry, action: TerminalSessionAction) => {
      if (action.kind === "open") {
        onOpenImported(
          {
            threadId: action.threadId,
            hostThreadId: action.hostThreadId,
            archived: action.archived,
          },
          entry.title,
        );
        onOpened();
        return;
      }
      setOpeningSessionId(entry.sessionId);
      const opened = await onContinueSession(entry.sessionId, action.mode, entry.title);
      setOpeningSessionId(null);
      if (opened) {
        onOpened();
      } else {
        // A session that went live since the listing now offers a copy.
        reload();
      }
    },
    [onContinueSession, onOpenImported, onOpened, reload],
  );

  return (
    <MenuGroup>
      <MenuGroupLabel>Claude Code terminal</MenuGroupLabel>
      {state.status === "loading" ? <HistoryNote>Loading…</HistoryNote> : null}
      {state.status === "failed" ? (
        <MenuItem closeOnClick={false} onClick={reload}>
          <span className="flex min-w-0 flex-col">
            <span className="text-xs">Couldn't load sessions. Select to retry.</span>
            <span className="text-muted-foreground text-xs">{state.reason}</span>
          </span>
        </MenuItem>
      ) : null}
      {state.status === "ready" && state.result.sessions.length === 0 ? (
        <HistoryNote>
          No Claude Code sessions in this folder.
          {props.localEnvironment
            ? null
            : ` Only sessions run on ${props.environmentLabel} appear here.`}
        </HistoryNote>
      ) : null}
      {state.status === "ready"
        ? state.result.sessions.map((entry) => (
            <TerminalSessionItem
              key={entry.sessionId}
              entry={entry}
              copySupported={state.result.copySupported}
              opening={openingSessionId === entry.sessionId}
              busy={openingSessionId !== null}
              onChoose={choose}
            />
          ))
        : null}
      {state.status === "ready" && state.result.truncated ? (
        <HistoryNote>Older sessions aren't shown.</HistoryNote>
      ) : null}
    </MenuGroup>
  );
}

function TerminalSessionItem(props: {
  readonly entry: AgentSessionHistoryEntry;
  readonly copySupported: boolean;
  readonly opening: boolean;
  readonly busy: boolean;
  readonly onChoose: (entry: AgentSessionHistoryEntry, action: TerminalSessionAction) => void;
}) {
  const { entry } = props;
  const row = terminalSessionRow(entry, props.copySupported);
  const details = [
    entry.branch,
    row.disabledReason ?? row.status,
    row.disabledReason === null ? (props.opening ? "Opening…" : row.actionLabel) : null,
  ].filter((part): part is string => part !== null);
  return (
    <MenuItem
      closeOnClick={false}
      disabled={row.disabledReason !== null || props.busy}
      onClick={() => props.onChoose(entry, row.action)}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-baseline gap-3">
          <span className="min-w-0 flex-1 truncate">{entry.title}</span>
          <span className="shrink-0 text-muted-foreground text-xs">
            {formatRelativeTimeLabel(entry.lastActiveAt)}
          </span>
        </span>
        <span className="truncate text-muted-foreground text-xs">{details.join(" · ")}</span>
      </span>
    </MenuItem>
  );
}
