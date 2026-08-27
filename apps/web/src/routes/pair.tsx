import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";

import {
  HostedPairingRouteSurface,
  PairingPendingSurface,
  PairingRouteSurface,
} from "../components/auth/PairingRouteSurface";
import { extractEmbeddedPairingToken } from "../components/auth/pairingCodeCredential";

export const Route = createFileRoute("/pair")({
  validateSearch: (search: Record<string, unknown>) =>
    typeof search.code === "string" && search.code.length > 0 ? { code: search.code } : {},
  beforeLoad: async ({ context, search }) => {
    const { authGateState } = context;
    if (authGateState.status === "hosted-pairing") {
      return {
        authGateState,
      };
    }

    if (authGateState.status === "authenticated" || authGateState.status === "hosted-static") {
      if (search?.code !== undefined) {
        throw redirect({
          to: "/settings/remote-servers",
          search: { code: search.code },
          replace: true,
        });
      }
      throw redirect({ to: "/", replace: true });
    }
    return {
      authGateState,
    };
  },
  component: PairRouteView,
  pendingComponent: PairRoutePendingView,
});

function PairRouteView() {
  const { authGateState } = Route.useRouteContext();
  const { code } = Route.useSearch();
  const navigate = useNavigate();

  if (!authGateState) {
    return null;
  }

  if (authGateState.status === "hosted-pairing") {
    return <HostedPairingRouteSurface />;
  }

  return (
    <PairingRouteSurface
      auth={authGateState.auth}
      {...(code === undefined
        ? {}
        : (() => {
            const embedded = extractEmbeddedPairingToken(code);
            return embedded === null ? {} : { initialCredential: embedded };
          })())}
      onAuthenticated={() => {
        void navigate({ to: "/", replace: true });
      }}
      {...(authGateState.errorMessage ? { initialErrorMessage: authGateState.errorMessage } : {})}
    />
  );
}

function PairRoutePendingView() {
  return <PairingPendingSurface />;
}
