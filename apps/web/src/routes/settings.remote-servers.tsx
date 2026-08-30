import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";

import { RemoteServersSettings } from "../components/settings/remote-servers/RemoteServersSettings";

export interface RemoteServersSearch {
  readonly tab?: "share";
  readonly code?: string;
  readonly action?: "add-server";
}

export function validateRemoteServersSearch(search: Record<string, unknown>): RemoteServersSearch {
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
  const [retainedPairingCode, setRetainedPairingCode] = useState(code ?? null);
  const scrubbedPairingCodeRef = useRef<string | null>(null);
  const consumeRetainedPairingCode = useCallback(() => setRetainedPairingCode(null), []);

  useEffect(() => {
    if (code === undefined) {
      scrubbedPairingCodeRef.current = null;
      return;
    }
    setRetainedPairingCode(code);
    if (scrubbedPairingCodeRef.current === code) return;
    scrubbedPairingCodeRef.current = code;
    void navigate({
      search: (previous) => ({
        ...(previous.tab === "share" ? { tab: "share" as const } : {}),
        ...(previous.action === "add-server" ? { action: "add-server" as const } : {}),
      }),
      replace: true,
    });
  }, [code, navigate]);

  return (
    <RemoteServersSettings
      initialTab={action === "add-server" ? "connect" : tab === "share" ? "share" : "connect"}
      initialPairingCode={retainedPairingCode}
      initialAddServerOpen={action === "add-server"}
      onPairingCodeConsumed={consumeRetainedPairingCode}
      onAddServerActionConsumed={() => {
        void navigate({
          search: (previous) => (previous.tab === "share" ? { tab: "share" as const } : {}),
          replace: true,
        });
      }}
    />
  );
}
