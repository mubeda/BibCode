import { createFileRoute } from "@tanstack/react-router";

import { AgentsSettingsPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/settings/agents")({
  component: AgentsSettingsPanel,
});
