/**
 * Marks the thread a Review or Second opinion was sent from as unread while its answer notice
 * waits. The mark is derived from the environment's request list and the ids the person has
 * opened, so it survives a reload and does not depend on the order pages arrive in. The tracker
 * is mounted once beside the agents unread tracker and subscribes once per environment.
 */
import { scopedThreadKey, scopeThreadRef } from "@bibcode/client-runtime/environment";
import type { EnvironmentId, SendRequest } from "@bibcode/contracts";
import { memo, useEffect, useMemo, useRef } from "react";

import { useSendRequestOpenedStore } from "~/sendRequestOpenedStore";
import { useSidebarWorkspaceMetaStore } from "~/sidebarWorkspaceMetaStore";
import { useServerConfigs } from "~/state/entities";
import { useSendRequests } from "~/state/sendRequests";

const ANSWERED_STATES = new Set<SendRequest["state"]>(["answered", "not_answered"]);
const KEPT_ACTIONS = new Set<SendRequest["action"]>(["review", "second-opinion"]);

/** Source threads with an undismissed, answered Review or Second opinion whose notice is unopened. */
export function unreadSourceKeys(input: {
  requests: ReadonlyArray<SendRequest>;
  openedIds: ReadonlySet<string>;
  environmentId: EnvironmentId;
}): ReadonlyArray<string> {
  const keys = new Set<string>();
  for (const request of input.requests) {
    if (
      KEPT_ACTIONS.has(request.action) &&
      ANSWERED_STATES.has(request.state) &&
      request.dismissedAt === null &&
      !input.openedIds.has(request.requestId)
    ) {
      keys.add(scopedThreadKey(scopeThreadRef(input.environmentId, request.sourceThreadId)));
    }
  }
  return [...keys];
}

function EnvironmentUnreadTracker(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const requests = useSendRequests(environmentId);
  const openedIds = useSendRequestOpenedStore((state) => state.openedIds);
  const markUnread = useSidebarWorkspaceMetaStore((state) => state.markUnread);
  const markRead = useSidebarWorkspaceMetaStore((state) => state.markRead);
  const keys = useMemo(
    () => unreadSourceKeys({ requests, openedIds: new Set(openedIds), environmentId }),
    [environmentId, openedIds, requests],
  );

  // Only keys this tracker marked are cleared again, when their notice is opened or goes away.
  const marked = useRef(new Set<string>());
  useEffect(() => {
    const current = new Set(keys);
    for (const key of current) {
      if (!marked.current.has(key)) {
        marked.current.add(key);
        markUnread(key);
      }
    }
    // Deleting the visited entry while iterating a Set is safe.
    for (const key of marked.current) {
      if (!current.has(key)) {
        marked.current.delete(key);
        markRead(key);
      }
    }
  }, [keys, markRead, markUnread]);

  // Forget the opened ids of dismissed requests. A request missing from the list is not gone: a
  // replacement snapshot carries only the first page, and the list cannot tell that from a removal.
  useEffect(() => {
    const retired = new Set(
      requests
        .filter((request) => request.dismissedAt !== null)
        .map((request) => request.requestId),
    );
    if (retired.size === 0) return;
    const { openedIds: opened, keepOnly } = useSendRequestOpenedStore.getState();
    if (opened.some((id) => retired.has(id))) keepOnly(opened.filter((id) => !retired.has(id)));
  }, [requests]);
  return null;
}

export const SendRequestsUnreadTracker = memo(function SendRequestsUnreadTracker() {
  const configs = useServerConfigs();
  const environmentIds = useMemo(
    () =>
      [...configs]
        .filter(([, config]) => config.environment?.capabilities?.sendRequests === true)
        .map(([environmentId]) => environmentId),
    [configs],
  );
  return environmentIds.map((environmentId) => (
    <EnvironmentUnreadTracker key={environmentId} environmentId={environmentId} />
  ));
});
