import { useState } from "react";

import { Tabs, TabsList, TabsPanel, TabsTab } from "../../ui/tabs";
import { SettingsPageContainer } from "../settingsLayout";
import { ConnectTab } from "./ConnectTab";
import { ShareThisHostTab } from "./ShareThisHostTab";

export type RemoteServersTab = "connect" | "share";

export function RemoteServersSettings({
  initialTab = "connect",
  initialPairingCode = null,
  initialAddServerOpen = false,
  onPairingCodeConsumed,
  onAddServerActionConsumed,
}: {
  readonly initialTab?: RemoteServersTab;
  readonly initialPairingCode?: string | null;
  readonly initialAddServerOpen?: boolean;
  readonly onPairingCodeConsumed?: () => void;
  readonly onAddServerActionConsumed?: () => void;
}) {
  const [tab, setTab] = useState<RemoteServersTab>(initialTab);
  return (
    <SettingsPageContainer>
      <Tabs value={tab} onValueChange={(value) => setTab(value === "share" ? "share" : "connect")}>
        <TabsList>
          <TabsTab value="connect">Connect to a host</TabsTab>
          <TabsTab value="share">Share this host</TabsTab>
        </TabsList>
        <TabsPanel value="connect">
          <ConnectTab
            initialPairingCode={initialPairingCode}
            {...(initialAddServerOpen ? { initialAddServerOpen: true } : {})}
            {...(onPairingCodeConsumed === undefined ? {} : { onPairingCodeConsumed })}
            {...(onAddServerActionConsumed === undefined
              ? {}
              : { onAddServerActionConsumed })}
          />
        </TabsPanel>
        <TabsPanel value="share">
          <ShareThisHostTab />
        </TabsPanel>
      </Tabs>
    </SettingsPageContainer>
  );
}
