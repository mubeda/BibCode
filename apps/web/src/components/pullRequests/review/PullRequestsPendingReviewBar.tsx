import { useState } from "react";
import { usePullRequestsStore } from "../../../pullRequestsStore";
import { Button } from "../../ui/button";
import { Popover, PopoverTrigger } from "../../ui/popover";
import {
  PullRequestsReviewPopover,
  type PullRequestsReviewProps,
} from "./PullRequestsReviewPopover";
export function PullRequestsPendingReviewBar(props: PullRequestsReviewProps) {
  const count = usePullRequestsStore(
    (s) => s.selectDraft(props.projectRef, props.detail.number).pendingReview.length,
  );
  const [open, setOpen] = useState(false);
  return (
    <div
      className="sticky top-0 z-10 shrink-0 border-b border-panel-separator bg-background px-3 py-2"
      data-text-surface="background"
    >
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger render={<Button variant={count > 0 ? "default" : "outline"} size="sm" />}>
          Review · {count} pending comments
        </PopoverTrigger>
        {open ? <PullRequestsReviewPopover {...props} onClose={() => setOpen(false)} /> : null}
      </Popover>
    </div>
  );
}
