import { scopeProjectRef } from "@bibcode/client-runtime/environment";
import type { EnvironmentId, ProjectId } from "@bibcode/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";

import { GitManagerPanel } from "../components/gitManager/GitManagerPanel";
import { selectHostThreadForProjectSurface } from "../components/pullRequests/openBesideThread.logic";
import { useRightPanelStore } from "../rightPanelStore";
import { useProject, useThreadShellsForProjectRefs } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { environmentShell } from "../state/shell";
import { buildThreadRouteParams } from "../threadRoutes";
import { ChatRouteInset } from "./-ChatRouteInset";

const MISSING_PROJECT_REDIRECT_DELAY_MS = 1_000;

function GitManagerRouteView() {
  const navigate = useNavigate();
  const params = Route.useParams();
  const { environmentId, projectId } = params;
  const projectRef = useMemo(
    () => scopeProjectRef(environmentId as EnvironmentId, projectId as ProjectId),
    [environmentId, projectId],
  );
  const projectRefs = useMemo(() => [projectRef], [projectRef]);
  const project = useProject(projectRef);
  const threads = useThreadShellsForProjectRefs(projectRefs);
  const shell = useEnvironmentQuery(environmentShell.stateAtom(projectRef.environmentId));
  const shellStatus = shell.data?.status ?? null;
  const projectExists = project !== null;
  const hostThreadRef = useMemo(
    () =>
      projectExists ? selectHostThreadForProjectSurface({ threads, preferredBranch: null }) : null,
    [projectExists, threads],
  );

  useEffect(() => {
    if (projectExists || shellStatus !== "live") return;
    const timeoutId = window.setTimeout(() => {
      void navigate({ to: "/", replace: true });
    }, MISSING_PROJECT_REDIRECT_DELAY_MS);
    return () => window.clearTimeout(timeoutId);
  }, [navigate, projectExists, shellStatus]);

  useEffect(() => {
    if (!projectExists || hostThreadRef === null) return;
    useRightPanelStore.getState().open(hostThreadRef, "gitManager");
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(hostThreadRef),
      replace: true,
    });
  }, [hostThreadRef, navigate, projectExists]);

  if (!projectExists || hostThreadRef !== null) return null;
  return (
    <ChatRouteInset>
      <GitManagerPanel projectRef={projectRef} />
    </ChatRouteInset>
  );
}

export const Route = createFileRoute("/_chat/project/$environmentId/$projectId/git")({
  component: GitManagerRouteView,
});
