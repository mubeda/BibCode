import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@bibcode/client-runtime/environment";
import type {
  EnvironmentId,
  OrchestrationOlderThreadsScope,
  OrchestrationThreadShell,
  ProjectId,
} from "@bibcode/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { LoaderIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { panelProviderLabel } from "../../centerPanelAdoption";
import { usePanelThreadOpener } from "../../centerPanelActions";
import { loadOlderThreads, olderPageKey, useOffShellState } from "../../state/offShell";
import { environmentShell } from "../../state/shell";
import { buildThreadRouteParams } from "../../threadRoutes";
import { workspaceCheckoutKey, type WorkspaceCardStatus } from "../Sidebar.logic";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { WorkspaceCardMoreChats } from "./WorkspaceCard";

interface WorkspaceCheckout {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  /** Null: the project's main checkout. */
  readonly worktreePath: string | null;
}

/**
 * A card's **N more chats**, which opens the checkout's chats: the ones the shell holds, then
 * the ones a capped shell left out (#223), loaded on request a page at a time.
 */
export function WorkspaceMoreChats(
  props: WorkspaceCheckout & {
    readonly count: number;
    readonly status: WorkspaceCardStatus;
    /** How many of `count` a capped shell left out. */
    readonly olderCount: number;
  },
) {
  const { count, status, olderCount, ...checkout } = props;
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const label = count === 1 ? "1 more chat" : `${count} more chats`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            data-card-control
            aria-label={`Show ${label}`}
            className="pointer-events-auto block w-full min-w-0 cursor-pointer rounded-sm text-left outline-hidden hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
          />
        }
      >
        <WorkspaceCardMoreChats count={count} status={status} />
      </PopoverTrigger>
      {/* `data-card-control`: clicks in the portal still bubble to the card through React. */}
      <PopoverPopup side="right" align="start" className="w-72" data-card-control>
        {open ? (
          <WorkspaceMoreChatsPopup {...checkout} olderCount={olderCount} onClose={close} />
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}

/** The open list, which alone needs the router and the panel opener. */
function WorkspaceMoreChatsPopup(
  props: WorkspaceCheckout & { readonly olderCount: number; readonly onClose: () => void },
) {
  const { onClose, ...list } = props;
  const navigate = useNavigate();
  const { openPanelThread } = usePanelThreadOpener();
  const openChat = useCallback(
    (thread: OrchestrationThreadShell) => {
      if (thread.hostThreadId === undefined) return;
      onClose();
      const hostRef = scopeThreadRef(list.environmentId, thread.hostThreadId);
      void openPanelThread(hostRef, thread.id, panelProviderLabel(thread.title) ?? thread.title);
      void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(hostRef) });
    },
    [list.environmentId, navigate, onClose, openPanelThread],
  );
  return <WorkspaceMoreChatsList {...list} onOpenChat={openChat} />;
}

const ROW_CLASS =
  "flex h-7 w-full min-w-0 items-center rounded-sm px-2 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-hidden";

/**
 * The checkout's chats: the shell's, then a row that loads the left-out ones a page at a time,
 * with its loading, failure and offline states.
 */
export function WorkspaceMoreChatsList(
  props: WorkspaceCheckout & {
    readonly olderCount: number;
    readonly onOpenChat: (thread: OrchestrationThreadShell) => void;
  },
) {
  const { environmentId, projectId, worktreePath, olderCount, onOpenChat } = props;
  const shellState = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const live = shellState.status === "live";
  const offShell = useOffShellState(environmentId);
  const scope = useMemo<OrchestrationOlderThreadsScope>(
    () => ({ kind: "checkout", projectId, worktreePath }),
    [projectId, worktreePath],
  );
  const page = offShell.pages.get(olderPageKey(scope));
  const [phase, setPhase] = useState<"idle" | "loading" | "error">("idle");
  const load = useCallback(
    async (append: boolean) => {
      setPhase("loading");
      const outcome = await loadOlderThreads(environmentId, scope, { append });
      setPhase(outcome === "failed" ? "error" : "idle");
    },
    [environmentId, scope],
  );

  const olderLabel = olderCount === 1 ? "1 older chat" : `${olderCount} older chats`;
  const shellChats = useMemo(() => {
    if (Option.isNone(shellState.snapshot)) return [];
    const key = workspaceCheckoutKey({ environmentId, projectId, worktreePath });
    return shellState.snapshot.value.threads.filter(
      (thread) =>
        thread.kind === "panel" &&
        thread.archivedAt === null &&
        workspaceCheckoutKey({ environmentId, ...thread }) === key,
    );
  }, [environmentId, projectId, shellState.snapshot, worktreePath]);
  const olderChats = useMemo(() => {
    const listed = new Set(shellChats.map((thread) => thread.id));
    return (page?.threadIds ?? []).flatMap((threadId) => {
      const thread = offShell.threads.get(threadId);
      return thread === undefined || listed.has(threadId) ? [] : [thread];
    });
  }, [offShell.threads, page, shellChats]);

  return (
    <div className="-mx-2 -my-2 flex flex-col gap-0.5" data-text-surface="popover">
      {[...shellChats, ...olderChats].map((thread) => (
        <button
          key={thread.id}
          type="button"
          data-sidebar-level="chat"
          className={ROW_CLASS}
          onClick={() => onOpenChat(thread)}
        >
          <span className="truncate">{thread.title}</span>
        </button>
      ))}
      {olderCount > 0 ? (
        <div className="px-2 pt-1 text-xs text-muted-foreground">
          {page === undefined && phase === "idle" ? (
            <button
              type="button"
              disabled={!live}
              className="underline underline-offset-2 hover:text-foreground disabled:no-underline disabled:opacity-60"
              {...(live ? {} : { "aria-description": "Reconnect to load older chats." })}
              onClick={() => void load(false)}
            >
              {live ? olderLabel : `${olderLabel}: reconnect to load`}
            </button>
          ) : phase === "loading" ? (
            <span role="status" className="flex items-center gap-2">
              <LoaderIcon className="size-3 animate-spin" aria-hidden />
              Loading older chats…
            </span>
          ) : phase === "error" ? (
            <span role="status" className="flex items-center gap-2">
              Couldn&apos;t load older chats.
              <button
                type="button"
                className="underline underline-offset-2 hover:text-foreground"
                onClick={() => void load(page !== undefined)}
              >
                Retry
              </button>
            </span>
          ) : page !== undefined && page.cursor !== null ? (
            <button
              type="button"
              disabled={!live}
              className="underline underline-offset-2 hover:text-foreground disabled:no-underline disabled:opacity-60"
              onClick={() => void load(true)}
            >
              Load 20 more
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
