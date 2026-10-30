import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@bibcode/client-runtime/environment";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import {
  selectVisibleCenterSurfaces,
  type ThreadCenterPanelState,
  useCenterPanelStore,
} from "../../centerPanelStore";
import { useSidebarWorkspaceMetaStore } from "../../sidebarWorkspaceMetaStore";
import { resolveThreadRouteRef } from "../../threadRoutes";
import type { AgentRow } from "./agentsSection.logic";

export function detectUnreadTransitions(input: {
  readonly previous: ReadonlyMap<string, string>;
  readonly rows: ReadonlyArray<AgentRow>;
  /** Threads the user is looking at: the routed thread and its chat panels on screen. */
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

/**
 * The chat panel threads on screen in the routed host's center layout, the
 * active tab of any split, as newline-joined thread keys (a stable selector
 * value).
 */
export function resolveVisiblePanelThreadKeys(
  byThreadKey: Readonly<Record<string, ThreadCenterPanelState>>,
  routeThreadKey: string | null,
): string {
  if (routeThreadKey === null) return "";
  const hostState = byThreadKey[routeThreadKey];
  const hostRef = parseScopedThreadKey(routeThreadKey);
  if (hostState === undefined || hostRef === null) return "";
  return selectVisibleCenterSurfaces(hostState)
    .flatMap(({ surface }) =>
      surface.kind === "chat"
        ? [scopedThreadKey(scopeThreadRef(hostRef.environmentId, surface.threadId))]
        : [],
    )
    .join("\n");
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
  const visiblePanelThreadKeys = useCenterPanelStore((state) =>
    resolveVisiblePanelThreadKeys(state.byThreadKey, openThreadKey),
  );
  const openThreadKeys = useMemo(() => {
    const keys = new Set<string>(
      visiblePanelThreadKeys === "" ? [] : visiblePanelThreadKeys.split("\n"),
    );
    if (openThreadKey !== null) keys.add(openThreadKey);
    return keys;
  }, [openThreadKey, visiblePanelThreadKeys]);
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
