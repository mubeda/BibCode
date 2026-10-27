import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@bibcode/client-runtime/environment";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import {
  selectFocusedCenterSurface,
  type ThreadCenterPanelState,
  useCenterPanelStore,
} from "../../centerPanelStore";
import { useSidebarWorkspaceMetaStore } from "../../sidebarWorkspaceMetaStore";
import { resolveThreadRouteRef } from "../../threadRoutes";
import type { AgentRow } from "./agentsSection.logic";

export function detectUnreadTransitions(input: {
  readonly previous: ReadonlyMap<string, string>;
  readonly rows: ReadonlyArray<AgentRow>;
  /** Threads the user is looking at: the routed thread and its focused chat panel. */
  readonly openThreadKeys: ReadonlySet<string>;
}): {
  readonly next: ReadonlyMap<string, string>;
  readonly markUnreadKeys: ReadonlyArray<string>;
} {
  const next = new Map<string, string>();
  const markUnreadKeys: string[] = [];

  for (const row of input.rows) {
    const latestTurn = row.shell.latestTurn;
    if (latestTurn === null) {
      continue;
    }

    const signature = `${latestTurn.turnId}:${latestTurn.state}`;
    next.set(row.key, signature);

    const settled =
      latestTurn.state === "completed" ||
      latestTurn.state === "interrupted" ||
      latestTurn.state === "error";
    if (
      input.previous.has(row.key) &&
      input.previous.get(row.key) !== signature &&
      settled &&
      !input.openThreadKeys.has(row.key)
    ) {
      markUnreadKeys.push(row.key);
    }
  }

  return { next, markUnreadKeys };
}

/** The chat panel thread focused in the routed host's center layout, as a thread key. */
export function resolveFocusedPanelThreadKey(
  byThreadKey: Readonly<Record<string, ThreadCenterPanelState>>,
  routeThreadKey: string | null,
): string | null {
  if (routeThreadKey === null) return null;
  const hostState = byThreadKey[routeThreadKey];
  const hostRef = parseScopedThreadKey(routeThreadKey);
  if (hostState === undefined || hostRef === null) return null;
  const focused = selectFocusedCenterSurface(hostState);
  return focused?.kind === "chat"
    ? scopedThreadKey(scopeThreadRef(hostRef.environmentId, focused.threadId))
    : null;
}

export function useAgentsUnread(rows: ReadonlyArray<AgentRow>): void {
  const previous = useRef<ReadonlyMap<string, string>>(new Map());
  const router = useRouter({ warn: false }) as ReturnType<typeof useRouter> | null;
  const subscribeToRoute = useCallback(
    (onStoreChange: () => void) =>
      typeof router?.subscribe === "function"
        ? router.subscribe("onResolved", onStoreChange)
        : () => undefined,
    [router],
  );
  const getOpenThreadKey = useCallback(() => {
    const matches = router?.state?.matches;
    const params = matches?.[matches.length - 1]?.params ?? {};
    const routeThreadRef = resolveThreadRouteRef(params);
    return routeThreadRef === null ? null : scopedThreadKey(routeThreadRef);
  }, [router]);
  const openThreadKey = useSyncExternalStore(subscribeToRoute, getOpenThreadKey, getOpenThreadKey);
  const focusedPanelThreadKey = useCenterPanelStore((state) =>
    resolveFocusedPanelThreadKey(state.byThreadKey, openThreadKey),
  );
  const openThreadKeys = useMemo(() => {
    const keys = new Set<string>();
    if (openThreadKey !== null) keys.add(openThreadKey);
    if (focusedPanelThreadKey !== null) keys.add(focusedPanelThreadKey);
    return keys;
  }, [focusedPanelThreadKey, openThreadKey]);
  const markUnread = useSidebarWorkspaceMetaStore((state) => state.markUnread);

  useEffect(() => {
    const result = detectUnreadTransitions({
      previous: previous.current,
      rows,
      openThreadKeys,
    });
    previous.current = result.next;
    for (const key of result.markUnreadKeys) {
      markUnread(key);
    }
  }, [markUnread, openThreadKeys, rows]);
}
