import { createFileRoute } from "@tanstack/react-router";

import { AboutSettingsPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/settings/about")({
  component: AboutSettingsPanel,
});
