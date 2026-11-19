import type { EnvironmentId } from "@bibcode/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { ServerTerminalPanel } from "../components/serverCommands/ServerTerminalPanel";
import { validateServerTerminalSearch } from "../components/serverCommands/serverCommands";
import { ChatRouteInset } from "./-ChatRouteInset";

function ServerTerminalRouteView() {
  const environmentId = Route.useParams().environmentId as EnvironmentId;
  const { open } = Route.useSearch();
  return (
    <ChatRouteInset>
      {/* Keyed: a param change must not keep one server's home folder for another. */}
      <ServerTerminalPanel key={environmentId} environmentId={environmentId} invocation={open} />
    </ChatRouteInset>
  );
}

export const Route = createFileRoute("/_chat/environment/$environmentId/terminal")({
  // `open` changes on every Open terminal, so running it again opens and focuses once more.
  validateSearch: validateServerTerminalSearch,
  component: ServerTerminalRouteView,
});
