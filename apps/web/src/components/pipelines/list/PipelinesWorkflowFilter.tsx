import type { PipelinesListPage } from "@bibcode/contracts";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { workflowFilterItems } from "./pipelinesList.logic";

type Workflows = NonNullable<PipelinesListPage["workflows"]>;

/**
 * GitHub's Workflow filter: every run, or one workflow's. Its choices come with the
 * list's first page, read when the list opens and on Refresh.
 */
export function PipelinesWorkflowFilter({
  workflows,
  value,
  onChange,
}: {
  workflows: Workflows;
  value: number | null;
  onChange: (value: number | null) => void;
}) {
  const items = workflowFilterItems(workflows, value);
  return (
    <div className="w-48">
      <Select
        modal={false}
        items={items}
        value={value === null ? "all" : String(value)}
        onValueChange={(next) => {
          if (next === null) return;
          onChange(next === "all" ? null : Number(next));
        }}
      >
        <SelectTrigger aria-label="Workflow" size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}
