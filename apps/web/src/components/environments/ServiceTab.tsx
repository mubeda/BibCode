import { Button } from "../ui/button";
import { EnvironmentSectionView } from "./EnvironmentSectionView";
import type { EnvironmentWorkspaceModel } from "./environmentWorkspaceModel";

export function ServiceTab({ model }: { readonly model: EnvironmentWorkspaceModel }) {
  return (
    <div className="space-y-5">
      <EnvironmentSectionView section={model.sections.service} />
      <section className="rounded-xl border border-border/70 bg-card/35 p-4">
        <h3 className="text-sm font-semibold">Host controls</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {model.hostControls.reason ??
            "Authorized through a verified desktop, local-control, or SSH administrator channel."}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {(["Start", "Stop", "Restart", "Update"] as const).map((action) => (
            <Button
              key={action}
              size="sm"
              variant="outline"
              disabled={!model.hostControls.enabled}
              title={model.hostControls.reason ?? undefined}
            >
              {action}
            </Button>
          ))}
        </div>
      </section>
    </div>
  );
}
