import { createFileRoute, redirect } from "@tanstack/react-router";

import { LocalEnvironmentSettings } from "../components/settings/LocalEnvironmentSettings";
import { RemoteServersSettings } from "../components/settings/remote-servers/RemoteServersSettings";
import { readCurrentEnvironmentPresentationPolicy } from "~/connection/currentEnvironmentPresentation";
import type { EnvironmentPresentationPolicy } from "~/connection/environmentPresentationPolicy";

export function connectionsRouteDestination(
  policy: EnvironmentPresentationPolicy,
): "/settings/connections" | "/settings/general" {
  return policy.connectionsPresentation === "redirect-general"
    ? "/settings/general"
    : "/settings/connections";
}

export const Route = createFileRoute("/settings/connections")({
  beforeLoad: () => {
    if (
      connectionsRouteDestination(readCurrentEnvironmentPresentationPolicy()) ===
      "/settings/general"
    ) {
      throw redirect({ to: "/settings/general", replace: true });
    }
  },
  component: ConnectionsRouteComponent,
});

function ConnectionsRouteComponent() {
  const policy = readCurrentEnvironmentPresentationPolicy();
  if (policy.connectionsPresentation === "local-wsl") return <LocalEnvironmentSettings />;
  if (policy.connectionsPresentation === "redirect-general") return null;
  return <RemoteServersSettings />;
}
