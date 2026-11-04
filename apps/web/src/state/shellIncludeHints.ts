import { parseScopedThreadKey } from "@bibcode/client-runtime/environment";
import { setShellIncludeHints } from "@bibcode/client-runtime/state/shell";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@bibcode/contracts";

import { useCenterPanelStore } from "../centerPanelStore";
import { useSidebarWorkspaceMetaStore } from "../sidebarWorkspaceMetaStore";
import { resolveThreadRouteRef } from "../threadRoutes";

/**
 * The threads a capped shell must keep for this client (#223), in priority order: the routed
 * thread, the hosts of open chat panels, then pinned and unread threads.
 */
export function shellIncludeThreadIds(
  environmentId: EnvironmentId,
  input: {
    readonly routed: ScopedThreadRef | null;
    readonly panelHostKeys: ReadonlyArray<string>;
    readonly pinnedKeys: ReadonlyArray<string>;
    readonly unreadKeys: ReadonlyArray<string>;
  },
): ReadonlyArray<ThreadId> {
  const ids = new Set<ThreadId>();
  if (input.routed?.environmentId === environmentId) ids.add(input.routed.threadId);
  for (const key of [...input.panelHostKeys, ...input.pinnedKeys, ...input.unreadKeys]) {
    const ref = parseScopedThreadKey(key);
    if (ref?.environmentId === environmentId) ids.add(ref.threadId);
  }
  return [...ids];
}

/** Feeds the shell subscription its include set from the router and the persisted stores. */
export function installShellIncludeHints(router: {
  readonly state: { readonly matches: ReadonlyArray<{ readonly params: unknown }> };
}): void {
  setShellIncludeHints((environmentId) => {
    const meta = useSidebarWorkspaceMetaStore.getState();
    const panelHostKeys = Object.entries(useCenterPanelStore.getState().byThreadKey).flatMap(
      ([threadKey, state]) =>
        state.surfaces.some((surface) => surface.kind === "chat") ? [threadKey] : [],
    );
    return shellIncludeThreadIds(environmentId, {
      routed: resolveThreadRouteRef(
        (router.state.matches.at(-1)?.params ?? {}) as Partial<
          Record<"environmentId" | "threadId", string | undefined>
        >,
      ),
      panelHostKeys,
      pinnedKeys: meta.pinnedThreadKeys,
      unreadKeys: meta.unreadThreadKeys,
    });
  });
}
