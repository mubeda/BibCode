import { useState } from "react";

import { Tabs, TabsList, TabsPanel, TabsTab } from "../../ui/tabs";
import { SettingsPageContainer } from "../settingsLayout";
import { ConnectTab } from "./ConnectTab";
import { ShareTab } from "./ShareTab";

export type RemoteServersTab = "connect" | "share";

export function RemoteServersSettings({
  initialTab = "connect",
}: {
  readonly initialTab?: RemoteServersTab;
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
          <ConnectTab />
        </TabsPanel>
        <TabsPanel value="share">
          <ShareTab />
        </TabsPanel>
      </Tabs>
    </SettingsPageContainer>
  );
}
