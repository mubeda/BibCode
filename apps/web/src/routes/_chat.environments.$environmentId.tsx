import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId } from "@bibcode/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { useCallback, useEffect, useMemo } from "react";

import { environmentCatalog } from "../connection/catalog";
import { EnvironmentWorkspace } from "../components/environments/EnvironmentWorkspace";
import {
  createEnvironmentWorkspaceModel,
  parseEnvironmentWorkspaceSearch,
  type EnvironmentWorkspaceTab,
} from "../components/environments/environmentWorkspaceModel";
import { buildEnvironmentWorkspaceSource } from "../components/environments/environmentWorkspaceSource";
import { setActiveEnvironmentId } from "../state/entities";
import { useEnvironment } from "../state/environments";
import { usePreparedConnection } from "../state/session";
import { environmentShell } from "../state/shell";
import { authEnvironment } from "../state/auth";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { useEnvironmentNavigationState } from "../useEnvironmentNavigationState";
import { ChatRouteInset } from "./-ChatRouteInset";

export function moveEnvironment(
  order: readonly EnvironmentId[],
  environmentId: EnvironmentId,
  direction: "earlier" | "later",
): EnvironmentId[] {
  const completeOrder = order.includes(environmentId) ? [...order] : [...order, environmentId];
  const currentIndex = completeOrder.indexOf(environmentId);
  const nextIndex = direction === "earlier" ? currentIndex - 1 : currentIndex + 1;
  if (currentIndex < 0 || nextIndex < 0 || nextIndex >= completeOrder.length) {
    return completeOrder;
  }
  const next = [...completeOrder];
  [next[currentIndex], next[nextIndex]] = [next[nextIndex]!, next[currentIndex]!];
  return next;
}

export function togglePinnedEnvironment(
  pinnedEnvironmentIds: readonly EnvironmentId[],
  environmentId: EnvironmentId,
): EnvironmentId[] {
  return pinnedEnvironmentIds.includes(environmentId)
    ? pinnedEnvironmentIds.filter((candidate) => candidate !== environmentId)
    : [...pinnedEnvironmentIds, environmentId];
}

function EnvironmentRouteView() {
  const params = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const environmentId = EnvironmentId.make(params.environmentId);
  const records = useAtomValue(environmentCatalog.environmentRecordsValueAtom);
  const environment = records.get(environmentId) ?? null;
  const presentation = useEnvironment(environmentId);
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const prepared = usePreparedConnection(environmentId);
  const authAccess = useEnvironmentQuery(
    presentation?.connection.phase === "connected"
      ? authEnvironment.accessChanges({ environmentId, input: null })
      : null,
  );
  const updateEnvironment = useAtomCommand(environmentCatalog.updateEnvironment, {
    reportFailure: true,
  });
  const navigation = useEnvironmentNavigationState({
    ready: records.size > 0,
    environmentIds: [...records.keys()],
    projects: [],
    selected: { environmentId, projectId: null, threadId: null },
  });

  useEffect(() => {
    setActiveEnvironmentId(environmentId);
  }, [environmentId]);

  const model = useMemo(() => {
    if (environment === null || presentation === null) return null;
    try {
      return createEnvironmentWorkspaceModel(
        buildEnvironmentWorkspaceSource({
          environment,
          presentation,
          shellStatus: shell.status,
          shellSnapshot: Option.getOrNull(shell.snapshot),
          activeRouteId: Option.isSome(prepared) ? (prepared.value.route?.routeId ?? null) : null,
          desktopBridgeAvailable:
            typeof window !== "undefined" && window.desktopBridge !== undefined,
          authAccessSnapshot: authAccess.data?.type === "snapshot" ? authAccess.data.payload : null,
        }),
      );
    } catch {
      return null;
    }
  }, [authAccess.data, environment, prepared, presentation, shell.snapshot, shell.status]);

  const handleTabChange = useCallback(
    (tab: EnvironmentWorkspaceTab) => {
      void navigate({
        to: "/environments/$environmentId",
        params: { environmentId },
        search: { tab },
        replace: true,
      });
    },
    [environmentId, navigate],
  );

  if (environment === null || presentation === null || model === null) {
    return (
      <ChatRouteInset>
        <main className="flex h-full items-center justify-center p-6 text-center">
          <div className="max-w-md">
            <h1 className="text-lg font-semibold">Environment details unavailable</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              This client has no verified identity metadata for the selected environment.
            </p>
          </div>
        </main>
      </ChatRouteInset>
    );
  }

  const order = navigation.state.environmentOrder.includes(environmentId)
    ? navigation.state.environmentOrder
    : [...navigation.state.environmentOrder, environmentId];
  const orderIndex = order.indexOf(environmentId);
  const pinned = navigation.state.pinnedEnvironmentIds.includes(environmentId);

  return (
    <ChatRouteInset>
      <EnvironmentWorkspace
        model={model}
        activeTab={search.tab}
        pinned={pinned}
        canMoveEarlier={orderIndex > 0}
        canMoveLater={orderIndex >= 0 && orderIndex < order.length - 1}
        onTabChange={handleTabChange}
        onSaveAlias={(alias) => {
          void updateEnvironment({ ...environment, alias });
        }}
        onTogglePinned={() => {
          navigation.update((current) => ({
            ...current,
            pinnedEnvironmentIds: togglePinnedEnvironment(
              current.pinnedEnvironmentIds,
              environmentId,
            ),
          }));
        }}
        onMove={(direction) => {
          navigation.update((current) => ({
            ...current,
            environmentOrder: moveEnvironment(current.environmentOrder, environmentId, direction),
          }));
        }}
      />
    </ChatRouteInset>
  );
}

export const Route = createFileRoute("/_chat/environments/$environmentId")({
  validateSearch: parseEnvironmentWorkspaceSearch,
  component: EnvironmentRouteView,
});
