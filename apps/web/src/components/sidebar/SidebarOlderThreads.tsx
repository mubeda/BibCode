import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@bibcode/client-runtime/environment";
import type {
  EnvironmentId,
  OrchestrationOlderThreadsScope,
  OrchestrationThreadShell,
  ProjectId,
  ScopedThreadRef,
} from "@bibcode/contracts";
import { LoaderIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { loadOlderThreads, olderPageKey, useOffShellState } from "../../state/offShell";
import { environmentShell } from "../../state/shell";
import { SidebarMenuSubButton, SidebarMenuSubItem } from "../ui/sidebar";

const ROW_CLASS =
  "h-6 w-full translate-x-0 justify-start px-2 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground";

const ENABLED_BUTTON = <button type="button" />;
const DISABLED_BUTTON = <button type="button" disabled />;

function threadCountLabel(count: number): string {
  return count === 1 ? "1 older thread" : `${count} older threads`;
}

/**
 * The project's threads a capped shell left out (#223): a row that loads them a page at a time,
 * newest first. Shown only while some were left out.
 */
export function SidebarOlderThreads(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly count: number;
  readonly onOpenThread: (threadRef: ScopedThreadRef) => void;
}) {
  const { environmentId, projectId, projectName, count, onOpenThread } = props;
  const offShell = useOffShellState(environmentId);
  const live = useAtomValue(environmentShell.stateValueAtom(environmentId)).status === "live";
  const scope = useMemo<OrchestrationOlderThreadsScope>(
    () => ({ kind: "project", projectId }),
    [projectId],
  );
  const page = offShell.pages.get(olderPageKey(scope));
  const [expanded, setExpanded] = useState(false);
  const [phase, setPhase] = useState<"idle" | "loading" | "error">("idle");
  const load = useCallback(
    async (append: boolean) => {
      setPhase("loading");
      const outcome = await loadOlderThreads(environmentId, scope, { append });
      setPhase(outcome === "failed" ? "error" : "idle");
    },
    [environmentId, scope],
  );
  const threads = useMemo(
    () =>
      (page?.threadIds ?? []).flatMap((threadId) => {
        const thread = offShell.threads.get(threadId);
        return thread === undefined ? [] : [thread];
      }),
    [offShell.threads, page],
  );

  if (!expanded) {
    if (count === 0) return null;
    const label = threadCountLabel(count);
    return (
      <SidebarMenuSubItem className="w-full">
        <SidebarMenuSubButton
          render={live ? ENABLED_BUTTON : DISABLED_BUTTON}
          data-thread-selection-safe
          size="sm"
          className={ROW_CLASS}
          aria-label={`${label} in ${projectName}`}
          {...(live ? {} : { "aria-description": "Reconnect to load older threads." })}
          onClick={() => {
            setExpanded(true);
            if (page === undefined) void load(false);
          }}
        >
          <span>{live ? label : `${label}: reconnect to load`}</span>
        </SidebarMenuSubButton>
      </SidebarMenuSubItem>
    );
  }

  const loadedEverything = page !== undefined && page.cursor === null;
  if (phase === "idle" && loadedEverything && threads.length === 0) return null;
  return (
    <>
      {threads.map((thread) => (
        <OlderThreadRow
          key={thread.id}
          thread={thread}
          onOpen={() => onOpenThread(scopeThreadRef(environmentId, thread.id))}
        />
      ))}
      {phase === "loading" ? (
        <SidebarMenuSubItem className="w-full">
          <span
            role="status"
            className="flex h-6 items-center gap-2 px-2 text-xs text-muted-foreground"
          >
            <LoaderIcon className="size-3 animate-spin" aria-hidden />
            Loading older threads…
          </span>
        </SidebarMenuSubItem>
      ) : null}
      {phase === "error" ? (
        <SidebarMenuSubItem className="w-full">
          <span
            role="status"
            className="flex h-6 items-center gap-2 px-2 text-xs text-muted-foreground"
          >
            Couldn&apos;t load older threads.
            <button
              type="button"
              className="underline underline-offset-2 hover:text-foreground"
              onClick={() => void load(page !== undefined)}
            >
              Retry
            </button>
          </span>
        </SidebarMenuSubItem>
      ) : null}
      {phase === "idle" && page !== undefined && page.cursor !== null ? (
        <SidebarMenuSubItem className="w-full">
          <SidebarMenuSubButton
            render={live ? ENABLED_BUTTON : DISABLED_BUTTON}
            data-thread-selection-safe
            size="sm"
            className={ROW_CLASS}
            onClick={() => void load(true)}
          >
            <span>Load 20 more</span>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      ) : null}
      <SidebarMenuSubItem className="w-full">
        <SidebarMenuSubButton
          render={ENABLED_BUTTON}
          data-thread-selection-safe
          size="sm"
          className={ROW_CLASS}
          onClick={() => setExpanded(false)}
        >
          <span>Hide older threads</span>
        </SidebarMenuSubButton>
      </SidebarMenuSubItem>
    </>
  );
}

function OlderThreadRow(props: {
  readonly thread: OrchestrationThreadShell;
  readonly onOpen: () => void;
}) {
  return (
    <SidebarMenuSubItem className="w-full">
      <SidebarMenuSubButton
        render={ENABLED_BUTTON}
        data-thread-selection-safe
        size="sm"
        className="h-6 w-full translate-x-0 justify-start px-2 text-left text-xs hover:bg-accent"
        onClick={props.onOpen}
      >
        <span className="truncate">{props.thread.title}</span>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}
