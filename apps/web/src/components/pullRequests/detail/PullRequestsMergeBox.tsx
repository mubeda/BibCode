import type { PullRequestsContext, PullRequestsDetail, ScopedProjectRef } from "@bibcode/contracts";
import { CircleCheckIcon, CircleDotIcon, CircleXIcon, TriangleAlertIcon } from "lucide-react";
import { memo } from "react";
import {
  PullRequestsMergeControls,
  PullRequestsUpdateBranch,
} from "../edit/PullRequestsMergeControls";
import { formatRelativeTimeLabel } from "../../../timestampFormat";
import { PullRequestsRevertButton } from "../edit/PullRequestsSecondaryActions";
import { readinessPresentation } from "./pullRequestsDetail.logic";
const TONES = {
  success: { Icon: CircleCheckIcon, color: "text-green-600 dark:text-green-400" },
  warning: { Icon: TriangleAlertIcon, color: "text-amber-600 dark:text-amber-400" },
  danger: { Icon: CircleXIcon, color: "text-red-600 dark:text-red-400" },
  neutral: { Icon: CircleDotIcon, color: "text-muted-foreground" },
};
export const PullRequestsMergeBox = memo(function PullRequestsMergeBox({
  detail,
  context,
  projectRef,
}: {
  projectRef: ScopedProjectRef;
  detail: PullRequestsDetail;
  context: Extract<PullRequestsContext, { status: "available" }>;
}) {
  const presentation = readinessPresentation(detail.readiness, context.capabilities.vocabulary);
  const tone = TONES[presentation.tone];
  const merged = detail.readiness.status === "merged";
  const closed = detail.readiness.status === "closed";
  return (
    <section
      aria-label="Merge status"
      data-tone={presentation.tone}
      className="space-y-3 rounded-lg border border-border p-4"
    >
      <header className="flex items-start gap-2">
        <tone.Icon aria-hidden="true" className={`mt-0.5 size-5 shrink-0 ${tone.color}`} />
        <h2 className="text-sm font-semibold">{presentation.title}</h2>
      </header>
      {presentation.lines.length > 0 ? (
        <ul className="list-inside list-disc space-y-1 text-sm text-muted-foreground">
          {presentation.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {detail.readiness.status === "conflicts" ? (
        <p className="text-sm text-muted-foreground">
          Use Checkout to resolve conflicts locally before merging.
        </p>
      ) : null}
      {merged ? (
        <>
          <p className="text-sm">
            {detail.mergedBy ? `Merged by ${detail.mergedBy.login}` : "Merged"}
            {detail.mergedAt ? (
              <>
                {" "}
                <time dateTime={detail.mergedAt} title={detail.mergedAt}>
                  {formatRelativeTimeLabel(detail.mergedAt)}
                </time>
              </>
            ) : null}
          </p>
          <PullRequestsRevertButton detail={detail} context={context} />
        </>
      ) : closed ? (
        <p className="text-sm">Closed</p>
      ) : (
        <>
          {detail.readiness.status === "behind" ? (
            <PullRequestsUpdateBranch detail={detail} context={context} />
          ) : null}
          <PullRequestsMergeControls detail={detail} context={context} projectRef={projectRef} />
        </>
      )}
    </section>
  );
});
