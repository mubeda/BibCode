/**
 * The left panel's agent-status clock and evidence stamps (#187): one owner for both,
 * shared by the Agents view rows and the workspace card glyphs.
 *
 * A Working status decays to "No update" when its provider evidence is 30 minutes old.
 * The age is measured on this client's clock from the first time it saw each piece of
 * evidence, with the server's own age of it at that moment taken off, so neither a
 * server's clock skew nor an app launch can stretch or shrink it.
 */
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef, scopedThreadKey } from "@bibcode/client-runtime/environment";
import { type EnvironmentId, type TerminalSummary, ThreadId } from "@bibcode/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMemo, useSyncExternalStore } from "react";

import {
  type AgentStatusContext,
  resolveWorkspaceCardStatus,
  type WorkspaceCardStatus,
  type WorkspaceCardStatusInput,
} from "../components/Sidebar.logic";
import {
  type AgentRowFreshness,
  type AgentTerminalSource,
  terminalAgentRowKey,
} from "../components/sidebar/agentsSection.logic";
import { appMinuteClock } from "../minuteClock";
import { useEnvironmentShellSummary } from "../state/shell";
import { terminalEnvironment } from "../state/terminal";

interface EvidenceStamp {
  readonly evidence: string;
  readonly evidenceAt: number;
}

/** Bounds the stamps a long session keeps; each row holds one. */
const STAMP_LIMIT = 4_096;
const stamps = new Map<string, EvidenceStamp>();

/**
 * When this client first saw `evidence` for the row `key`, on its own clock: the time
 * of that first sight less the server's age of the evidence then. A repeated value
 * keeps its first time; a new one restamps. Only a connected environment stamps, since
 * a cached snapshot's age is as old as the cache. Null when there is no evidence.
 */
export function agentEvidenceAt(
  key: string,
  evidence: string | undefined,
  ageMs: number | undefined,
  live: boolean,
  now: number = Date.now(),
): number | null {
  if (evidence === undefined) return null;
  const stamp = stamps.get(key);
  if (stamp?.evidence === evidence) return stamp.evidenceAt;
  if (!live) return null;
  if (stamp === undefined && stamps.size >= STAMP_LIMIT) {
    const oldest = stamps.keys().next().value;
    if (oldest !== undefined) stamps.delete(oldest);
  }
  const evidenceAt = now - Math.max(0, ageMs ?? 0);
  stamps.set(key, { evidence, evidenceAt });
  return evidenceAt;
}

export function resetAgentEvidenceStampsForTests(): void {
  stamps.clear();
}

const noSubscription = () => () => {};

/**
 * The minute-resolution time the status rules read. Only a caller with a status that
 * can decay subscribes, so idle lists and cards pay no timer cost.
 */
export function useAgentStatusClock(active: boolean): number {
  return useSyncExternalStore(
    active ? appMinuteClock.subscribe : noSubscription,
    appMinuteClock.getSnapshot,
    appMinuteClock.getSnapshot,
  );
}

/**
 * The environments known to be disconnected, from the shared shell summary. One the
 * summary does not list yet counts as connected: only a known disconnection makes a
 * card's claim offline.
 */
export function useDisconnectedEnvironmentIds(): ReadonlySet<string> {
  const statuses = useEnvironmentShellSummary().statuses;
  return useMemo(
    () =>
      new Set(
        statuses
          .filter(({ status }) => status !== "live")
          .map(({ environmentId }) => environmentId),
      ),
    [statuses],
  );
}

function sameAgentTerminals(
  left: ReadonlyArray<TerminalSummary>,
  right: ReadonlyArray<TerminalSummary>,
): boolean {
  return (
    left.length === right.length &&
    left.every((terminal, index) => {
      const other = right[index]!;
      return (
        terminal.terminalId === other.terminalId &&
        terminal.status === other.status &&
        terminal.agentStatus?.state === other.agentStatus?.state &&
        terminal.agentStatus?.failed === other.agentStatus?.failed &&
        terminal.agentStatus?.observedAt === other.agentStatus?.observedAt
      );
    })
  );
}

const EMPTY_TERMINALS: ReadonlyArray<TerminalSummary> = Object.freeze([]);

/** An environment's AI Terminals, keeping identity until one changes status. */
const environmentAgentTerminalsAtom = Atom.family((environmentId: EnvironmentId) => {
  let previous = EMPTY_TERMINALS;
  return Atom.make((get) => {
    const all =
      Option.getOrNull(
        AsyncResult.value(get(terminalEnvironment.metadata({ environmentId, input: null }))),
      ) ?? EMPTY_TERMINALS;
    const next = all.filter((terminal) => terminal.agentStatus !== undefined);
    if (!sameAgentTerminals(previous, next)) {
      previous = next.length === 0 ? EMPTY_TERMINALS : next;
    }
    return previous;
  }).pipe(Atom.withLabel("environment-agent-terminals"));
});

/**
 * A thread's AI Terminals, as one atom per thread whose value keeps its identity until
 * one of them changes status, so a card re-renders for its own agents only and not for
 * every terminal's output activity in its environment.
 */
const threadAgentTerminalsAtom = Atom.family((key: string) => {
  const [environmentId, threadId] = JSON.parse(key) as [EnvironmentId, string];
  let previous = EMPTY_TERMINALS;
  return Atom.make((get) => {
    if (environmentId === "") return EMPTY_TERMINALS;
    const next = get(environmentAgentTerminalsAtom(environmentId)).filter(
      (terminal) => terminal.threadId === threadId,
    );
    if (!sameAgentTerminals(previous, next)) {
      previous = next.length === 0 ? EMPTY_TERMINALS : next;
    }
    return previous;
  }).pipe(Atom.withLabel("thread-agent-terminals"));
});

export function useThreadAgentTerminals(
  environmentId: EnvironmentId,
  threadId: string,
): ReadonlyArray<TerminalSummary> {
  return (
    useAtomValue(threadAgentTerminalsAtom(JSON.stringify([environmentId, threadId]))) ??
    EMPTY_TERMINALS
  );
}

const EMPTY_TERMINAL_SOURCES: ReadonlyArray<AgentTerminalSource> = Object.freeze([]);

/** The AI Terminal sources of a list of environments, keyed by the joined ids. */
const agentTerminalSourcesAtom = Atom.family((key: string) => {
  const ids = key === "" ? [] : (JSON.parse(key) as EnvironmentId[]);
  let previous = EMPTY_TERMINAL_SOURCES;
  return Atom.make((get): ReadonlyArray<AgentTerminalSource> => {
    const next = ids.map((environmentId) => ({
      environmentId,
      rows: get(environmentAgentTerminalsAtom(environmentId)),
    }));
    if (
      next.length !== previous.length ||
      next.some((source, index) => source.rows !== previous[index]!.rows)
    ) {
      previous = next.length === 0 ? EMPTY_TERMINAL_SOURCES : next;
    }
    return previous;
  }).pipe(Atom.withLabel("agent-terminal-sources"));
});

/**
 * Every environment's AI Terminals for the Agents view, one stable source per
 * environment whose rows keep their identity until an agent's status changes.
 */
export function useAgentTerminalSources(
  environmentIds: ReadonlyArray<EnvironmentId>,
): ReadonlyArray<AgentTerminalSource> {
  const key = environmentIds.length === 0 ? "" : JSON.stringify(environmentIds);
  return useAtomValue(agentTerminalSourcesAtom(key)) ?? EMPTY_TERMINAL_SOURCES;
}

/** The status clock and evidence stamps an Agents row list reads. */
export function useAgentRowFreshness(active: boolean): AgentRowFreshness {
  const now = useAgentStatusClock(active);
  return useMemo(() => ({ now, evidenceAt: agentEvidenceAt }), [now]);
}

/**
 * A workspace card's glyph, with its chat's freshness and connection and the status of
 * the AI Terminals in its workspace. The single call site change in `Sidebar.tsx`.
 */
export function useWorkspaceCardStatus(
  thread:
    | (WorkspaceCardStatusInput & {
        readonly environmentId: EnvironmentId;
        readonly id: string;
        readonly lastActivityAt?: string | undefined;
        readonly lastActivityAgeMs?: number | undefined;
      })
    | null
    | undefined,
  lastVisitedAt: string | null | undefined,
  fallback: WorkspaceCardStatus,
): WorkspaceCardStatus {
  const environmentId = thread?.environmentId ?? ("" as EnvironmentId);
  const threadId = thread?.id ?? "";
  const terminals = useThreadAgentTerminals(environmentId, threadId);
  const live = !useDisconnectedEnvironmentIds().has(environmentId);
  const decayable =
    thread?.session?.status === "running" ||
    thread?.session?.status === "starting" ||
    terminals.some((terminal) => terminal.agentStatus?.state === "working");
  const now = useAgentStatusClock(decayable);
  if (thread === null || thread === undefined) return fallback;
  const threadKey = scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(threadId)));
  const context: AgentStatusContext & {
    terminals: Array<{ terminal: TerminalSummary; evidenceAt: number | null }>;
  } = {
    now,
    environmentLive: live,
    evidenceAt: agentEvidenceAt(threadKey, thread.lastActivityAt, thread.lastActivityAgeMs, live),
    terminals: terminals.map((terminal) => ({
      terminal,
      evidenceAt: agentEvidenceAt(
        terminalAgentRowKey(threadKey, terminal.terminalId),
        terminal.agentStatus?.observedAt,
        terminal.agentStatus?.ageMs,
        live,
      ),
    })),
  };
  return resolveWorkspaceCardStatus(thread, lastVisitedAt, context);
}
