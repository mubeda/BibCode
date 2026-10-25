import { useNavigate } from "@tanstack/react-router";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import type { PipelineAttemptOptions } from "./pipelineDetail.logic";

/**
 * A re-run GitHub run's attempts. Choosing one opens its page (`?attempt=`), whose
 * header and jobs describe that attempt; the latest needs no search.
 */
export function PipelineAttemptSelect({
  options,
  projectRef,
  pipelineId,
}: {
  options: PipelineAttemptOptions;
  projectRef: { readonly environmentId: string; readonly projectId: string };
  pipelineId: number;
}) {
  const navigate = useNavigate();
  return (
    <div className="w-44">
      <Select
        modal={false}
        items={options.items}
        value={options.value}
        onValueChange={(next) => {
          if (next === null || next === options.value) return;
          void navigate({
            to: "/project/$environmentId/$projectId/pipelines/$pipelineId",
            params: {
              environmentId: projectRef.environmentId,
              projectId: projectRef.projectId,
              pipelineId: String(pipelineId),
            },
            search: next === "latest" ? {} : { attempt: Number(next) },
          });
        }}
      >
        <SelectTrigger aria-label="Attempt" size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {options.items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}
