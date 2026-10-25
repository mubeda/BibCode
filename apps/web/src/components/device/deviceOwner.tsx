import { scopeThreadRef } from "@bibcode/client-runtime/environment";
import type { DeviceSnapshot, EnvironmentId, ThreadId } from "@bibcode/contracts";

import { useThreadShell } from "../../state/entities";
import { runningSuffix, startedInNote, stopConfirmDescription } from "./deviceMessages";

/**
 * Whose a device is, seen from the pane's root thread (a chat panel's host, else the thread):
 * the pane's own, another thread's, or nobody's (started by an older client, or a server
 * without owners).
 */
export type DeviceOwner =
  | { readonly kind: "here" }
  | { readonly kind: "thread"; readonly threadId: ThreadId }
  | { readonly kind: "none" };

export function deviceOwnerOf(device: DeviceSnapshot, rootThreadId: ThreadId): DeviceOwner {
  if (device.threadId === undefined) return { kind: "none" };
  return device.threadId === rootThreadId
    ? { kind: "here" }
    : { kind: "thread", threadId: device.threadId };
}

/** The title of the thread that started a device, or null while this client does not know it. */
function useOwnerTitle(environmentId: EnvironmentId, threadId: ThreadId): string | null {
  return useThreadShell(scopeThreadRef(environmentId, threadId))?.title ?? null;
}

/** " — Running in Fix login", with the thread's title once this client knows it. */
function ThreadRunningSuffix({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  return runningSuffix({ kind: "thread", title: useOwnerTitle(environmentId, threadId) });
}

/** What the picker says after a running image's name: whose device runs it. */
export function DeviceRunningSuffix({
  environmentId,
  owner,
}: {
  readonly environmentId: EnvironmentId;
  readonly owner: DeviceOwner;
}) {
  if (owner.kind === "thread") {
    return <ThreadRunningSuffix environmentId={environmentId} threadId={owner.threadId} />;
  }
  return runningSuffix(owner.kind === "here" ? { kind: "here" } : { kind: "none" });
}

/** "Started in Fix login.", for a device another thread started. */
export function DeviceStartedIn({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  return startedInNote(useOwnerTitle(environmentId, threadId));
}

/** "It was started in Fix login.", for the confirmation before stopping another thread's device. */
export function DeviceStopConfirmDescription({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  return stopConfirmDescription(useOwnerTitle(environmentId, threadId));
}
