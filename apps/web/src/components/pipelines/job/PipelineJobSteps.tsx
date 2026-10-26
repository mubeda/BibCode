import type { PipelinesJobDetail } from "@bibcode/contracts";
import { useJobLog } from "../log/JobLog";
import { PipelineStatusIcon } from "../shared/PipelineStatusIcon";
import { formatPipelineDuration, pipelineStatusText } from "../shared/pipelineStatus.logic";
import { stepDurationSeconds } from "./pipelineJob.logic";

type Step = PipelinesJobDetail["steps"][number];

/**
 * A GitHub job's steps with their status and time. Once the log is loaded with its
 * timestamps, a step jumps to where its output starts; a running job's log stays on
 * GitHub, so the steps are what BiBCode shows of its progress.
 */
export function PipelineJobSteps({ steps }: { steps: readonly Step[] }) {
  const {
    state: { layout },
    actions: { revealTime },
  } = useJobLog();
  if (steps.length === 0) return null;
  const jumpable = layout?.hasTimestamps ?? false;
  return (
    <section aria-labelledby="pipeline-job-steps" className="space-y-2">
      <h2 id="pipeline-job-steps" className="font-semibold">
        Steps
      </h2>
      <ol className="space-y-0.5">
        {steps.map((step) => {
          const status = pipelineStatusText(step.status, false, null);
          const duration = stepDurationSeconds(step);
          const startedAt = step.startedAt === null ? Number.NaN : Date.parse(step.startedAt);
          const content = (
            <>
              <PipelineStatusIcon status={step.status} warnings={false} />
              <span className="min-w-0 flex-1 truncate">{step.name}</span>
              {duration !== null ? (
                <span className="shrink-0 text-muted-foreground tabular-nums">
                  {formatPipelineDuration(duration)}
                </span>
              ) : null}
            </>
          );
          return (
            <li key={step.number}>
              {jumpable && Number.isFinite(startedAt) ? (
                <button
                  type="button"
                  aria-label={`${step.name}: ${status.toLowerCase()}. Show in the log`}
                  onClick={() => revealTime(startedAt)}
                  className="flex min-h-7 w-full items-center gap-2 rounded-md px-1.5 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                >
                  {content}
                </button>
              ) : (
                <div className="flex min-h-7 items-center gap-2 px-1.5">
                  {content}
                  <span className="sr-only">{status}</span>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
