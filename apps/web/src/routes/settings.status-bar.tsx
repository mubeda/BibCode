import { createFileRoute } from "@tanstack/react-router";

import { StatusBarSettingsPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/settings/status-bar")({
  component: StatusBarSettingsPanel,
});
