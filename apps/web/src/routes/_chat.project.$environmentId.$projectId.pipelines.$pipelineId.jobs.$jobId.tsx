import { scopeProjectRef } from "@bibcode/client-runtime/environment";
import type { EnvironmentId, ProjectId } from "@bibcode/contracts";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";

import { PipelineJobPanel } from "../components/pipelines/job/PipelineJobPanel";
import {
  parsePipelineRouteId,
  validatePipelineJobSearch,
} from "../components/pipelines/job/pipelineJobRoute";
import { useProject } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { environmentShell } from "../state/shell";
import { ChatRouteInset } from "./-ChatRouteInset";

const MISSING_PROJECT_REDIRECT_DELAY_MS = 1_000;

function PipelineJobRouteView() {
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

  if (!projectExists) return null;
  return (
    <ChatRouteInset>
      <PipelineJobPanel
        projectRef={projectRef}
        pipelineId={Number(params.pipelineId)}
        jobId={Number(params.jobId)}
        at={search.at ?? null}
      />
    </ChatRouteInset>
  );
}

export const Route = createFileRoute(
  "/_chat/project/$environmentId/$projectId/pipelines/$pipelineId/jobs/$jobId",
)({
  // `at` is a log line's byte offset, so a copied line link opens on that line.
  validateSearch: validatePipelineJobSearch,
  beforeLoad: ({ params }) => {
    if (
      parsePipelineRouteId(params.pipelineId) === null ||
      parsePipelineRouteId(params.jobId) === null
    ) {
      throw redirect({
        to: "/project/$environmentId/$projectId/pipelines",
        params: { environmentId: params.environmentId, projectId: params.projectId },
        replace: true,
      });
    }
  },
  component: PipelineJobRouteView,
});
