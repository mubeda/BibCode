import type { EnvironmentId } from "@bibcode/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { HostDashboardPanel } from "../components/hostDashboard/HostDashboardPanel";
import { ChatRouteInset } from "./-ChatRouteInset";

function ServerDashboardRouteView() {
  const environmentId = Route.useParams().environmentId as EnvironmentId;
  return (
    <ChatRouteInset>
      {/* Keyed: a param change must not carry one server's readings to another. */}
      <HostDashboardPanel key={environmentId} environmentId={environmentId} />
    </ChatRouteInset>
  );
}

export const Route = createFileRoute("/_chat/environment/$environmentId/dashboard")({
  component: ServerDashboardRouteView,
});
