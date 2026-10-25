import { scopeProjectRef } from "@bibcode/client-runtime/environment";
import type { EnvironmentId, ProjectId } from "@bibcode/contracts";
import { createFileRoute, Outlet, useChildMatches, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";

import { PipelinesPanel } from "../components/pipelines/PipelinesPanel";
import { validatePipelinesSearch } from "../components/pipelines/list/pipelinesList.logic";
import { useProject } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { environmentShell } from "../state/shell";
import { ChatRouteInset } from "./-ChatRouteInset";

const MISSING_PROJECT_REDIRECT_DELAY_MS = 1_000;

function PipelinesListRouteView() {
  // A pipeline (or a page below it) renders in the list's place.
  const childMatches = useChildMatches();
  const navigate = useNavigate();
  const params = Route.useParams();
  const search = Route.useSearch();
  const { environmentId, projectId } = params;
  const projectRef = useMemo(
    () => scopeProjectRef(environmentId as EnvironmentId, projectId as ProjectId),
    [environmentId, projectId],
  );
  const project = useProject(projectRef);
  const shell = useEnvironmentQuery(environmentShell.stateAtom(projectRef.environmentId));
  const shellStatus = shell.data?.status ?? null;
  const projectExists = project !== null;

  useEffect(() => {
    if (projectExists || shellStatus !== "live") return;
    const timeoutId = window.setTimeout(() => {
      void navigate({ to: "/", replace: true });
    }, MISSING_PROJECT_REDIRECT_DELAY_MS);
    return () => window.clearTimeout(timeoutId);
  }, [navigate, projectExists, shellStatus]);

  if (childMatches.length > 0) return <Outlet />;
  if (!projectExists) return null;
  return (
    <ChatRouteInset>
      <PipelinesPanel projectRef={projectRef} search={search} />
    </ChatRouteInset>
  );
}

export const Route = createFileRoute("/_chat/project/$environmentId/$projectId/pipelines")({
  // Filters live in the URL, so Back and a copied link keep them.
  validateSearch: validatePipelinesSearch,
  component: PipelinesListRouteView,
});
