import { PullRequestsMarkdown } from "../shared/PullRequestsMarkdown";
import { PullRequestsTextEditor, type PullRequestsEditorProps } from "./PullRequestsTextEditor";
export function PullRequestsBodyEditor(props: PullRequestsEditorProps) {
  return (
    <PullRequestsTextEditor {...props} field="body">
      {props.detail.body ? (
        <PullRequestsMarkdown
          text={props.detail.body}
          {...(props.baseUrl ? { baseUrl: props.baseUrl } : {})}
        />
      ) : (
        <p className="text-sm text-muted-foreground">No description provided</p>
      )}
    </PullRequestsTextEditor>
  );
}
