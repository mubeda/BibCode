import type {
  EnvironmentId,
  OrchestrationMessage,
  OrchestrationProjectShell,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadShell,
  ThreadId,
} from "@bibcode/contracts";

export interface EnvironmentProject extends OrchestrationProjectShell {
  readonly environmentId: EnvironmentId;
}

/** A thread shell as this client received it. */
export interface ReceivedThreadShell extends OrchestrationThreadShell {
  /**
   * When `lastActivityAt` happened on this client's clock: the shell's receipt time less
   * `lastActivityAgeMs`. Recorded on receipt because an unchanged thread is not sent again,
   * so its age stays as old as the item that carried it. Absent without that age, and from
   * cached shells.
   */
  readonly lastActivityObservedAt?: number;
}

export interface EnvironmentThreadShell extends ReceivedThreadShell {
  readonly environmentId: EnvironmentId;
}

/** `thread` with its activity age pinned to `receivedAt`; the same object when it has none. */
export function observeThreadActivity<T extends OrchestrationThreadShell>(
  thread: T,
  receivedAt: number,
): T & ReceivedThreadShell {
  return thread.lastActivityAgeMs === undefined
    ? thread
    : { ...thread, lastActivityObservedAt: receivedAt - thread.lastActivityAgeMs };
}

/** How old the thread's provider progress is at `now`, on this client's clock. */
export function threadActivityAgeMs(
  thread: {
    readonly lastActivityAgeMs?: number | undefined;
    readonly lastActivityObservedAt?: number | undefined;
  },
  now: number,
): number | undefined {
  return thread.lastActivityObservedAt === undefined
    ? thread.lastActivityAgeMs
    : Math.max(0, now - thread.lastActivityObservedAt);
}

export type EnvironmentMessage = OrchestrationMessage;

export interface EnvironmentThread extends OrchestrationThread {
  readonly environmentId: EnvironmentId;
}

export function scopeProject(
  environmentId: EnvironmentId,
  project: OrchestrationProjectShell,
): EnvironmentProject {
  return { ...project, environmentId };
}

export function scopeThreadShell(
  environmentId: EnvironmentId,
  thread: OrchestrationThreadShell,
): EnvironmentThreadShell {
  return { ...thread, environmentId };
}

export function scopeThread(
  environmentId: EnvironmentId,
  thread: OrchestrationThread,
): EnvironmentThread {
  return { ...thread, environmentId };
}

export function selectEnvironmentThreadShell(
  snapshot: OrchestrationShellSnapshot | null,
  environmentId: EnvironmentId,
  threadId: ThreadId,
): EnvironmentThreadShell | null {
  const thread = snapshot?.threads.find((candidate) => candidate.id === threadId) ?? null;
  return thread ? scopeThreadShell(environmentId, thread) : null;
}
