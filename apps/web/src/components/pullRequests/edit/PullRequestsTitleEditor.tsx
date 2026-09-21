import { PullRequestsTextEditor, type PullRequestsEditorProps } from "./PullRequestsTextEditor";
export function PullRequestsTitleEditor({
  numberPrefix = "#",
  ...props
}: PullRequestsEditorProps & { numberPrefix?: string }) {
  return (
    <PullRequestsTextEditor {...props} field="title">
      <h1 className="min-w-0 break-words text-xl font-semibold">
        {props.detail.title}{" "}
        <span className="font-normal text-muted-foreground">
          {numberPrefix}
          {props.detail.number}
        </span>
      </h1>
    </PullRequestsTextEditor>
  );
}
