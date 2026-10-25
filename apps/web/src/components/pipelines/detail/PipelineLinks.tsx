import type { ToOptions } from "@tanstack/react-router";
import { createContext, use } from "react";
import { pipelineJobLink } from "../job/pipelineJobRoute";

/**
 * Where the stage views link a job. The stage components never ask where they are
 * rendered: the view that mounts them says, so the merge request tab can reuse
 * them later with links of its own.
 */
export interface PipelineLinks {
  /** An in-app job page, or `null` to open the host's job page instead. */
  readonly jobLink: (jobId: number) => ToOptions | null;
}

/** Outside a pipeline page, a job opens on the host. */
const HOST_JOB_LINKS: PipelineLinks = { jobLink: () => null };

/** The pipeline page's links: each job opens its job page in BiBCode. */
export function pipelinePageLinks(target: {
  readonly environmentId: string;
  readonly projectId: string;
  readonly pipelineId: number;
}): PipelineLinks {
  return { jobLink: (jobId) => pipelineJobLink({ ...target, jobId }) };
}

const PipelineLinksContext = createContext<PipelineLinks>(HOST_JOB_LINKS);

export const PipelineLinksProvider = PipelineLinksContext;

export function usePipelineLinks(): PipelineLinks {
  return use(PipelineLinksContext);
}
