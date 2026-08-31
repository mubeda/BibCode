import { createFileRoute, redirect } from "@tanstack/react-router";

import { LocalEnvironmentSettings } from "../components/settings/LocalEnvironmentSettings";
import { readCurrentEnvironmentPresentationPolicy } from "~/connection/currentEnvironmentPresentation";

export const Route = createFileRoute("/settings/local-environment")({
  beforeLoad: () => {
    if (!readCurrentEnvironmentPresentationPolicy().showLocalEnvironmentSettings) {
      throw redirect({ to: "/settings/remote-servers", replace: true });
    }
  },
  component: LocalEnvironmentSettings,
});
