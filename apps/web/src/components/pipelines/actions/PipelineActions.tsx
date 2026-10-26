import { squashAtomCommandFailure } from "@bibcode/client-runtime/state/runtime";
import type {
  EnvironmentId,
  PipelinesActionResult,
  PullRequestsPipelineStatus,
  PullRequestsProviderKind,
} from "@bibcode/contracts";
import { Loader2Icon } from "lucide-react";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { pipelinesEnvironment } from "../../../state/pipelines";
import { useAtomCommand } from "../../../state/use-atom-command";
import { MenuItem } from "../../ui/menu";
import { PermissionButton, type ActionPermission } from "../../ui/permission-button";
import { toastManager } from "../../ui/toast";
import {
  pipelineActionError,
  pipelineActionHostDetail,
  pipelineActionKey,
  shownPipelineStatus,
  type PipelineActionRequest,
} from "./pipelineActions.logic";

/** A re-read that never lands still lets the button go after this long. */
const REREAD_WAIT_MS = 15_000;
const SENDING = Number.POSITIVE_INFINITY;
const NO_PENDING: ReadonlyMap<string, number> = new Map();
const NO_CANCELING: ReadonlyMap<number, PullRequestsPipelineStatus> = new Map();
const WAITING = "Waiting for the host…";

export interface PipelineActionOutcome {
  readonly request: PipelineActionRequest;
  /** `null` when the action failed; the view re-reads either way, so a refusal shows. */
  readonly result: PipelinesActionResult | null;
}

type ShownRow = {
  readonly id: number;
  readonly status: PullRequestsPipelineStatus;
  readonly terminal: boolean;
};

interface PipelineActionsValue {
  readonly state: {
    /** True from the click until a newer copy of the page lands. */
    readonly busy: (request: PipelineActionRequest) => boolean;
    readonly status: (row: ShownRow) => PullRequestsPipelineStatus;
  };
  readonly actions: {
    /** `from` is the status shown at the click, which a GitHub cancel keeps as canceling. */
    readonly run: (request: PipelineActionRequest, from: PullRequestsPipelineStatus | null) => void;
  };
}

const PipelineActionsContext = createContext<PipelineActionsValue | null>(null);

function usePipelineActions(): PipelineActionsValue {
  const value = use(PipelineActionsContext);
  if (!value) throw new Error("Pipeline actions need a PipelineActions.Provider");
  return value;
}

function withEntry<K, V>(map: ReadonlyMap<K, V>, key: K, value: V | undefined): Map<K, V> {
  const next = new Map(map);
  if (value === undefined) next.delete(key);
  else next.set(key, value);
  return next;
}

/**
 * Runs Retry, Cancel and Play for one page. A button spins from the click until the
 * page's next copy lands (`revision` grows), so its result is on screen when it stops;
 * a second click on the same action while it runs sends nothing. Every answer, failed
 * or not, goes to `onSettled`, which re-reads (a refusal then shows at the button) and
 * may navigate. A failure is also a toast with the host's own copy.
 */
function Provider({
  scope,
  provider,
  revision,
  onSettled,
  children,
}: {
  scope: { readonly environmentId: EnvironmentId; readonly cwd: string };
  provider: PullRequestsProviderKind;
  /** The shown copy's revision: a higher one is the re-read after an action. */
  revision: number | null;
  onSettled: (outcome: PipelineActionOutcome) => void;
  children: ReactNode;
}) {
  const command = useAtomCommand(pipelinesEnvironment.runAction, {
    reportFailure: false,
    reportDefect: false,
  });
  const [pending, setPending] = useState(NO_PENDING);
  const [canceling, setCanceling] = useState(NO_CANCELING);
  const sending = useRef(new Set<string>());
  const shownRevision = useRef(revision);
  useEffect(() => {
    shownRevision.current = revision;
  }, [revision]);
  const timers = useRef(new Set<number>());
  useEffect(() => {
    const pendingTimers = timers.current;
    return () => {
      for (const timer of pendingTimers) window.clearTimeout(timer);
    };
  }, []);
  const { environmentId, cwd } = scope;
  const run = useCallback(
    async (request: PipelineActionRequest, from: PullRequestsPipelineStatus | null) => {
      const key = pipelineActionKey(request);
      if (sending.current.has(key)) return;
      sending.current.add(key);
      setPending((map) => withEntry(map, key, SENDING));
      let result: PipelinesActionResult | null = null;
      try {
        const exit = await command({ environmentId, input: { cwd, ...request } });
        if (exit._tag === "Failure") throw squashAtomCommandFailure(exit);
        result = exit.value;
        const settledAt = shownRevision.current ?? 0;
        setPending((map) => withEntry(map, key, settledAt));
        const timer = window.setTimeout(() => {
          timers.current.delete(timer);
          setPending((map) => withEntry(map, key, undefined));
        }, REREAD_WAIT_MS);
        timers.current.add(timer);
        // GitHub cancels in the background (202): show it until the run moves on.
        if (
          provider === "github" &&
          request.action === "cancel" &&
          request.target._tag === "pipeline" &&
          from !== null
        )
          setCanceling((map) => withEntry(map, request.target.id, from));
      } catch (cause) {
        setPending((map) => withEntry(map, key, undefined));
        const description = pipelineActionHostDetail(cause);
        toastManager.add({
          type: "error",
          title: pipelineActionError(cause),
          ...(description === null ? {} : { description }),
        });
      } finally {
        sending.current.delete(key);
      }
      onSettled({ request, result });
    },
    [command, cwd, environmentId, onSettled, provider],
  );
  // A new copy matters only while an action waits for it, so a poll with nothing
  // pending re-renders no button.
  const awaitedRevision = pending.size === 0 ? null : (revision ?? 0);
  const value = useMemo<PipelineActionsValue>(
    () => ({
      state: {
        busy: (request) => {
          const awaited = pending.get(pipelineActionKey(request));
          return (
            awaited !== undefined && (awaited === SENDING || (awaitedRevision ?? 0) <= awaited)
          );
        },
        status: (row) => shownPipelineStatus(row, canceling),
      },
      actions: { run: (request, from) => void run(request, from) },
    }),
    [awaitedRevision, canceling, pending, run],
  );
  return <PipelineActionsContext value={value}>{children}</PipelineActionsContext>;
}

type ButtonProps = Omit<ComponentProps<typeof PermissionButton>, "permission" | "onClick">;

/** One action's button; the spinner takes the icon's place while it runs. */
function Button({
  request,
  permission,
  from = null,
  icon = null,
  children,
  ...props
}: ButtonProps & {
  request: PipelineActionRequest;
  permission: ActionPermission;
  /** The status shown at the click (a pipeline's), for GitHub's background cancel. */
  from?: PullRequestsPipelineStatus | null;
  icon?: ReactNode;
}) {
  const {
    state: { busy },
    actions: { run },
  } = usePipelineActions();
  const running = busy(request);
  return (
    <PermissionButton
      {...props}
      // A running action keeps its button focusable, so the keyboard keeps its place;
      // it only ignores clicks until the result is on screen.
      aria-busy={running || undefined}
      aria-disabled={running || undefined}
      permission={permission}
      onClick={(event) => {
        // A row's actions sit above its link.
        event.stopPropagation();
        if (!running) run(request, from);
      }}
    >
      {running ? <Loader2Icon aria-hidden="true" className="motion-safe:animate-spin" /> : icon}
      {children}
    </PermissionButton>
  );
}

/** One action in a menu: disabled with its reason, and while it runs. */
function Item({
  request,
  permission,
  children,
}: {
  request: PipelineActionRequest;
  permission: ActionPermission;
  children: ReactNode;
}) {
  const {
    state: { busy },
    actions: { run },
  } = usePipelineActions();
  const running = busy(request);
  // A disabled item takes no pointer, so its reason is written under its label.
  const reason = running ? WAITING : permission.allowed ? null : permission.reason;
  return (
    <MenuItem disabled={running || !permission.allowed} onClick={() => run(request, null)}>
      <span className="flex min-w-0 flex-col">
        <span>{children}</span>
        {reason ? <span className="text-xs text-muted-foreground">{reason}</span> : null}
      </span>
    </MenuItem>
  );
}

/** The status a pipeline shows: GitHub's background cancel reads as canceling. */
function useShownStatus(row: ShownRow): PullRequestsPipelineStatus {
  const value = use(PipelineActionsContext);
  return value === null ? row.status : value.state.status(row);
}

export const PipelineActions = { Provider, Button, Item, useShownStatus };
