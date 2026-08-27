import { createFileRoute } from "@tanstack/react-router";

import { RemoteServersSettings } from "../components/settings/remote-servers/RemoteServersSettings";

export const Route = createFileRoute("/settings/remote-servers")({
  validateSearch: (search: Record<string, unknown>) => ({
    ...(search.tab === "share" ? { tab: "share" as const } : {}),
    ...(typeof search.code === "string" && search.code.length > 0 ? { code: search.code } : {}),
  }),
  component: RemoteServersRouteView,
});

function RemoteServersRouteView() {
  const { tab, code } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <RemoteServersSettings
      initialTab={tab === "share" ? "share" : "connect"}
      initialPairingCode={code ?? null}
      onPairingCodeConsumed={() => {
        void navigate({
          search: (previous) => (previous.tab === "share" ? { tab: "share" as const } : {}),
          replace: true,
        });
      }}
    />
  );
}
