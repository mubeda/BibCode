import { scopeProjectRef } from "@bibcode/client-runtime/environment";
import type { EnvironmentId, ProjectId } from "@bibcode/contracts";
import {
  createFileRoute,
  Outlet,
  redirect,
  useChildMatches,
  useNavigate,
} from "@tanstack/react-router";
import { useEffect, useMemo } from "react";

import { PipelinesPanel } from "../components/pipelines/PipelinesPanel";
import { useProject } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { environmentShell } from "../state/shell";
import { ChatRouteInset } from "./-ChatRouteInset";

const MISSING_PROJECT_REDIRECT_DELAY_MS = 1_000;

/** A route id is the host's global id: a whole number a JavaScript `Number` holds exactly. */
function isPipelineId(value: string): boolean {
  return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) >= 1;
}

function PipelineRouteView() {
  // A page below this one (a job) renders in its place.
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
      <PipelinesPanel
        projectRef={projectRef}
        pipelineId={Number(params.pipelineId)}
        attempt={search.attempt ?? null}
      />
    </ChatRouteInset>
  );
}

export const Route = createFileRoute(
  "/_chat/project/$environmentId/$projectId/pipelines/$pipelineId",
)({
  // `attempt` opens a GitHub run's earlier attempt; the latest needs none.
  validateSearch: (search: Record<string, unknown>): { attempt?: number } => {
    const attempt = typeof search.attempt === "string" ? Number(search.attempt) : search.attempt;
    return typeof attempt === "number" && Number.isSafeInteger(attempt) && attempt >= 1
      ? { attempt }
      : {};
  },
  beforeLoad: ({ params }) => {
    if (!isPipelineId(params.pipelineId)) {
      throw redirect({
        to: "/project/$environmentId/$projectId/pipelines",
        params: { environmentId: params.environmentId, projectId: params.projectId },
        replace: true,
      });
    }
  },
  component: PipelineRouteView,
});
