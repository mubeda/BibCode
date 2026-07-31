import { createFileRoute } from "@tanstack/react-router";

import { TerminalSettingsPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/settings/terminal")({
  component: TerminalSettingsPanel,
});
