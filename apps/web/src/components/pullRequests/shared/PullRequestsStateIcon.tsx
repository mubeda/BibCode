import {
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
} from "lucide-react";
const STATES = {
  open: { Icon: GitPullRequestIcon, color: "text-green-600 dark:text-green-400" },
  draft: { Icon: GitPullRequestDraftIcon, color: "text-muted-foreground" },
  merged: { Icon: GitMergeIcon, color: "text-purple-600 dark:text-purple-400" },
  closed: { Icon: GitPullRequestClosedIcon, color: "text-red-600 dark:text-red-400" },
};
export function PullRequestsStateIcon({ state }: { state: keyof typeof STATES }) {
  const { Icon, color } = STATES[state];
  return (
    <span role="img" aria-label={state} className={`shrink-0 ${color}`}>
      <Icon aria-hidden="true" className="size-4" />
    </span>
  );
}
