import type { ToOptions } from "@tanstack/react-router";
import { createContext, use } from "react";

/**
 * Where the stage views link a job. The stage components never ask where they are
 * rendered: the view that mounts them says, so the merge request tab can reuse
 * them later with links of its own.
 */
export interface PipelineLinks {
  /** An in-app job page, or `null` to open the host's job page instead. */
  readonly jobLink: (jobId: number) => ToOptions | null;
}

/** Until the job page ships, every job opens on the host. */
const HOST_JOB_LINKS: PipelineLinks = { jobLink: () => null };

const PipelineLinksContext = createContext<PipelineLinks>(HOST_JOB_LINKS);

export const PipelineLinksProvider = PipelineLinksContext;

export function usePipelineLinks(): PipelineLinks {
  return use(PipelineLinksContext);
}
