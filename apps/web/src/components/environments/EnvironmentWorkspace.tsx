import { ArrowDownIcon, ArrowUpIcon, PinIcon, ServerIcon } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ConnectionTab } from "./ConnectionTab";
import { DiagnosticsTab } from "./DiagnosticsTab";
import {
  environmentWorkspaceTabs,
  type EnvironmentWorkspaceModel,
  type EnvironmentWorkspaceTab,
} from "./environmentWorkspaceModel";
import { OverviewTab } from "./OverviewTab";
import { PlatformTab } from "./PlatformTab";
import { ProjectsStorageTab } from "./ProjectsStorageTab";
import { SecurityTab } from "./SecurityTab";
import { ServiceTab } from "./ServiceTab";
import { UpdatesTab } from "./UpdatesTab";

export interface EnvironmentWorkspaceProps {
  readonly model: EnvironmentWorkspaceModel;
  readonly activeTab: EnvironmentWorkspaceTab;
  readonly pinned: boolean;
  readonly onTabChange: (tab: EnvironmentWorkspaceTab) => void;
  readonly onSaveAlias: (alias: string | null) => void;
  readonly onTogglePinned: () => void;
  readonly canMoveEarlier: boolean;
  readonly canMoveLater: boolean;
  readonly onMove: (direction: "earlier" | "later") => void;
}

function EnvironmentTabContent({
  model,
  activeTab,
}: Pick<EnvironmentWorkspaceProps, "model" | "activeTab">) {
  switch (activeTab) {
    case "overview":
      return <OverviewTab section={model.sections.overview} />;
    case "connection":
      return <ConnectionTab section={model.sections.connection} />;
    case "service":
      return <ServiceTab model={model} />;
    case "security":
      return <SecurityTab section={model.sections.security} />;
    case "projects":
      return <ProjectsStorageTab section={model.sections.projects} />;
    case "updates":
      return <UpdatesTab section={model.sections.updates} />;
    case "diagnostics":
      return <DiagnosticsTab section={model.sections.diagnostics} />;
    case "platform":
      return <PlatformTab section={model.sections.platform} />;
  }
}

export function EnvironmentWorkspace({
  model,
  activeTab,
  pinned,
  onTabChange,
  onSaveAlias,
  onTogglePinned,
  canMoveEarlier,
  canMoveLater,
  onMove,
}: EnvironmentWorkspaceProps) {
  const [alias, setAlias] = useState(model.displayLabel);
  useEffect(() => setAlias(model.displayLabel), [model.displayLabel]);

  const saveAlias = (event: FormEvent) => {
    event.preventDefault();
    const normalized = alias.trim();
    onSaveAlias(normalized === "" || normalized === model.canonicalLabel ? null : normalized);
  };

  return (
    <main
      aria-label="Environment workspace"
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background text-foreground"
    >
      <header className="border-b border-border/70 px-4 pt-4 sm:px-6">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-card text-muted-foreground">
                <ServerIcon className="size-4" aria-hidden />
              </span>
              <div className="min-w-0">
                <h1 className="truncate text-base font-semibold">{model.displayLabel}</h1>
                <p className="truncate text-xs text-muted-foreground">
                  {model.canonicalLabel} · {model.status.replaceAll("-", " ")}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!canMoveEarlier}
                onClick={() => onMove("earlier")}
              >
                <ArrowUpIcon className="size-3.5" aria-hidden />
                Move earlier
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!canMoveLater}
                onClick={() => onMove("later")}
              >
                <ArrowDownIcon className="size-3.5" aria-hidden />
                Move later
              </Button>
              <Button
                size="sm"
                variant={pinned ? "secondary" : "outline"}
                aria-pressed={pinned}
                onClick={onTogglePinned}
              >
                <PinIcon className="size-3.5" aria-hidden />
                {pinned ? "Pinned" : "Pin environment"}
              </Button>
            </div>
          </div>

          <form className="flex max-w-xl items-end gap-2" onSubmit={saveAlias}>
            <label className="min-w-0 flex-1 text-xs font-medium text-muted-foreground">
              Client alias
              <Input
                className="mt-1"
                aria-label="Client alias"
                value={alias}
                onChange={(event) => setAlias(event.target.value)}
              />
            </label>
            <Button size="sm" type="submit" variant="outline">
              Save alias
            </Button>
          </form>

          <div
            role="tablist"
            aria-label="Environment sections"
            className="scrollbar-none flex gap-1 overflow-x-auto pb-0"
          >
            {environmentWorkspaceTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`environment-tab-${tab.id}`}
                aria-controls={`environment-panel-${tab.id}`}
                aria-selected={tab.id === activeTab}
                className={cn(
                  "shrink-0 border-b-2 px-3 py-2 text-xs font-medium transition-colors motion-reduce:transition-none",
                  tab.id === activeTab
                    ? "border-foreground text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
                onClick={() => onTabChange(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        <div className="mx-auto w-full max-w-5xl space-y-5">
          {model.banner ? (
            <aside
              role="status"
              className={cn(
                "rounded-xl border px-4 py-3",
                model.banner.kind === "offline"
                  ? "border-border bg-muted/35"
                  : "border-warning/35 bg-warning/8",
              )}
            >
              <p className="text-sm font-semibold">{model.banner.title}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {model.banner.description}
              </p>
            </aside>
          ) : null}

          <div
            role="tabpanel"
            id={`environment-panel-${activeTab}`}
            aria-labelledby={`environment-tab-${activeTab}`}
            tabIndex={0}
            className="outline-hidden focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <EnvironmentTabContent model={model} activeTab={activeTab} />
          </div>
        </div>
      </div>
    </main>
  );
}
