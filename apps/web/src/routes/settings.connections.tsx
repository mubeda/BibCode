import { createFileRoute, redirect } from "@tanstack/react-router";

import { ConnectionsSettings } from "../components/settings/ConnectionsSettings";
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
  component: ConnectionsSettings,
});
