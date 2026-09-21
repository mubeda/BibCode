import { PullRequestsBodyEditor } from "../edit/PullRequestsBodyEditor";
import { PullRequestsPendingReviewBar } from "../review/PullRequestsPendingReviewBar";
import type { PullRequestsScope } from "../usePullRequestsAction";
import { usePullRequestsActions } from "../usePullRequestsAction";
import { PullRequestsConversationComment } from "../review/PullRequestsCommentBox";
import type {
  PullRequestsContext,
  PullRequestsDetail,
  PullRequestsTimeline,
  ScopedProjectRef,
} from "@bibcode/contracts";
import { LegendList } from "@legendapp/list/react";
import { memo, useCallback, useMemo } from "react";
import { formatRelativeTimeLabel } from "../../../timestampFormat";
import { PullRequestsActor } from "../shared/PullRequestsActor";
import { PullRequestsExternalLink } from "../shared/PullRequestsMarkdown";
import { PullRequestsReactions } from "../shared/PullRequestsReactions";
import { groupTimeline } from "./pullRequestsDetail.logic";
import { PullRequestsTimelineItem } from "./PullRequestsTimelineItem";
import { PullRequestsSideColumn } from "./PullRequestsSideColumn";
import { PullRequestsMergeBox } from "./PullRequestsMergeBox";
export interface PullRequestsConversationProps {
  detail: PullRequestsDetail;
  context: Extract<PullRequestsContext, { status: "available" }>;
  scope: PullRequestsScope;
  projectRef: ScopedProjectRef;
  timeline: PullRequestsTimeline;
  detailsRefreshing?: boolean;
}
const timelineKey = (item: PullRequestsTimeline["items"][number]) => item.id;
export const PullRequestsConversation = memo(function PullRequestsConversation({
  detail,
  context,
  projectRef,
  scope,
  timeline,
  detailsRefreshing = false,
}: PullRequestsConversationProps) {
  const { run, pending } = usePullRequestsActions();
  const items = useMemo(() => groupTimeline(timeline.items), [timeline.items]);
  const renderItem = useCallback(
    ({ item }: { item: PullRequestsTimeline["items"][number] }) => (
      <PullRequestsTimelineItem
        item={item}
        permissions={detail.permissions}
        projectRef={projectRef}
        number={detail.number}
        context={context}
        url={detail.url}
      />
    ),
    [context, detail.number, detail.permissions, detail.url, projectRef],
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PullRequestsPendingReviewBar detail={detail} context={context} projectRef={projectRef} />
      <LegendList
        data={items}
        keyExtractor={timelineKey}
        renderItem={renderItem}
        extraData={renderItem}
        recycleItems={false}
        estimatedItemSize={220}
        className="min-h-0 flex-1"
        role="list"
        aria-label="Conversation"
        data-text-surface="background"
        ListHeaderComponent={
          <article className="m-3 space-y-3 rounded-lg border border-border p-3">
            <header className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2">
                <PullRequestsActor actor={detail.author} />
                <time
                  dateTime={detail.createdAt}
                  title={detail.createdAt}
                  className="text-muted-foreground"
                >
                  {formatRelativeTimeLabel(detail.createdAt)}
                </time>
              </div>
            </header>
            <PullRequestsBodyEditor
              detail={detail}
              projectRef={projectRef}
              baseUrl={`${context.webUrl}/`}
            />
            <PullRequestsReactions
              reactions={detail.reactions}
              permission={detail.permissions.react}
              busy={pending}
              onToggle={(content, on) => run({ action: "react", targetId: null, content, on })}
            />
          </article>
        }
        ListFooterComponent={
          <div className="space-y-4 p-3">
            {timeline.truncated ? (
              <p className="text-sm">
                <PullRequestsExternalLink href={detail.url}>
                  Older activity is on the host page
                </PullRequestsExternalLink>
              </p>
            ) : null}
            <PullRequestsConversationComment
              permission={detail.permissions.comment}
              projectRef={projectRef}
              number={detail.number}
            />
            <div className="lg:hidden">
              <PullRequestsSideColumn
                detail={detail}
                context={context}
                scope={scope}
                projectRef={projectRef}
                detailsRefreshing={detailsRefreshing}
              />
            </div>
            <PullRequestsMergeBox detail={detail} context={context} projectRef={projectRef} />
          </div>
        }
      />
    </div>
  );
});
