import { createFileRoute } from "@tanstack/react-router";

import { RemoteServersSettings } from "../components/settings/remote-servers/RemoteServersSettings";

export interface RemoteServersSearch {
  readonly tab?: "share";
  readonly code?: string;
  readonly action?: "add-server";
}

export function validateRemoteServersSearch(
  search: Record<string, unknown>,
): RemoteServersSearch {
  return {
    ...(search.tab === "share" ? { tab: "share" as const } : {}),
    ...(typeof search.code === "string" && search.code.length > 0 ? { code: search.code } : {}),
    ...(search.action === "add-server" ? { action: "add-server" as const } : {}),
  };
}

export const Route = createFileRoute("/settings/remote-servers")({
  validateSearch: validateRemoteServersSearch,
  component: RemoteServersRouteView,
});

function RemoteServersRouteView() {
  const { tab, code, action } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <RemoteServersSettings
      initialTab={action === "add-server" ? "connect" : tab === "share" ? "share" : "connect"}
      initialPairingCode={code ?? null}
      initialAddServerOpen={action === "add-server"}
      onPairingCodeConsumed={() => {
        void navigate({
          search: (previous) => ({
            ...(previous.tab === "share" ? { tab: "share" as const } : {}),
            ...(previous.action === "add-server"
              ? { action: "add-server" as const }
              : {}),
          }),
          replace: true,
        });
      }}
      onAddServerActionConsumed={() => {
        void navigate({
          search: (previous) => ({
            ...(previous.tab === "share" ? { tab: "share" as const } : {}),
            ...(typeof previous.code === "string" && previous.code.length > 0
              ? { code: previous.code }
              : {}),
          }),
          replace: true,
        });
      }}
    />
  );
}
