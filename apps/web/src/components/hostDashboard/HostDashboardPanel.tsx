import type { EnvironmentId } from "@bibcode/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { useEnvironment } from "~/state/environments";

import { ServerPanelFrame } from "../serverCommands/ServerPanelFrame";
import { HostDashboardBody, useHostDashboard } from "./HostDashboardSheet";

/** The host dashboard as a server's center panel; leaving the route ends its stream. */
export function HostDashboardPanel({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const navigate = useNavigate();
  const environment = useEnvironment(environmentId);
  const dashboard = useHostDashboard(environmentId, environment);
  const openRemoteServers = useCallback(
    () => void navigate({ to: "/settings/remote-servers" }),
    [navigate],
  );
  return (
    <ServerPanelFrame environmentId={environmentId} title="Dashboard" testId="host-dashboard-panel">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          data-text-surface="background"
          className="mx-auto grid w-full max-w-3xl gap-5 p-4 text-sm sm:p-6"
        >
          <HostDashboardBody dashboard={dashboard} onOpenRemoteServers={openRemoteServers} />
        </div>
      </div>
    </ServerPanelFrame>
  );
}
