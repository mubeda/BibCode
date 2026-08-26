import { AlertTriangleIcon, ArrowLeftIcon, EyeIcon, EyeOffIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import {
  getEnvironmentRemovalAvailability,
  validateEnvironmentRemoval,
  type EnvironmentRemovalContext,
  type EnvironmentRemovalOutcome,
  type EnvironmentRemovalSelection,
} from "./environmentRemovalModel";

export interface EnvironmentRemovalWorkspaceProps {
  readonly context: EnvironmentRemovalContext;
  readonly now?: Date;
  readonly busy?: boolean;
  readonly onBack: () => void;
  readonly onHide: () => Promise<void> | void;
  readonly onRestore: () => Promise<void> | void;
  readonly onDisconnect: () => Promise<void> | void;
  readonly onRequestFreshPlan: () => Promise<void> | void;
  readonly onRemove: (selection: EnvironmentRemovalSelection) => Promise<EnvironmentRemovalOutcome>;
}

const OFFLINE_FORCE_WARNINGS = [
  "The BiBCode Server may keep running on the host.",
  "Remote projects, worktrees, and data remain untouched.",
  "Other clients remain paired with the server.",
  "Re-adding this environment requires pairing again.",
  "Manual host cleanup may still be required.",
] as const;

export function EnvironmentRemovalWorkspace({
  context,
  now,
  busy = false,
  onBack,
  onHide,
  onRestore,
  onDisconnect,
  onRequestFreshPlan,
  onRemove,
}: EnvironmentRemovalWorkspaceProps) {
  const removalNow = useMemo(() => now ?? new Date(), [now]);
  const [uninstallServer, setUninstallServer] = useState(false);
  const [purgeRemoteData, setPurgeRemoteData] = useState(false);
  const [typedAlias, setTypedAlias] = useState("");
  const [forceRemoveConfirmed, setForceRemoveConfirmed] = useState(false);
  const [outcome, setOutcome] = useState<EnvironmentRemovalOutcome | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const availability = getEnvironmentRemovalAvailability(context, removalNow);
  const offline = context.reachability !== "online";
  const selection = useMemo<EnvironmentRemovalSelection>(
    () => ({ uninstallServer, purgeRemoteData, typedAlias, forceRemoveConfirmed }),
    [forceRemoveConfirmed, purgeRemoteData, typedAlias, uninstallServer],
  );
  const validation = validateEnvironmentRemoval(context, selection, removalNow);
  const working = busy || submitting;

  const remove = async () => {
    if (!validation.valid || working) return;
    setSubmitting(true);
    setOutcome(null);
    try {
      setOutcome(await onRemove(selection));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main
      aria-label="Environment removal workspace"
      className="h-full min-h-0 overflow-y-auto bg-background px-4 py-5 text-foreground sm:px-6"
    >
      <div className="mx-auto w-full max-w-3xl space-y-5">
        <header className="space-y-3">
          <Button size="sm" variant="ghost" onClick={onBack}>
            <ArrowLeftIcon className="size-3.5" aria-hidden />
            Back to environment
          </Button>
          <div>
            <h1 className="text-xl font-semibold">Remove {context.alias}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Client cleanup, server uninstall, and remote data deletion are separate actions.
            </p>
          </div>
        </header>

        {context.kind === "primary" ? (
          <Alert variant="warning">
            <AlertTriangleIcon aria-hidden />
            <AlertTitle>Primary environment is permanent</AlertTitle>
            <AlertDescription>
              The primary environment cannot be hidden, forgotten, uninstalled, or purged here.
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <section className="rounded-xl border border-border/70 bg-card/35 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="font-medium">
                    {context.hidden ? "Restore in navigation" : "Hide from navigation"}
                  </h2>
                  <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
                    Routes, credentials, cached content, projects, worktrees, and settings remain.
                    This only changes client presentation metadata and can be undone from Settings →
                    Environments.
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={working}
                  onClick={() => void (context.hidden ? onRestore() : onHide())}
                >
                  {context.hidden ? (
                    <EyeIcon className="size-3.5" aria-hidden />
                  ) : (
                    <EyeOffIcon className="size-3.5" aria-hidden />
                  )}
                  {context.hidden ? "Restore" : "Hide"}
                </Button>
              </div>
            </section>

            <section className="rounded-xl border border-border/70 bg-card/35 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="font-medium">Disconnect temporarily</h2>
                  <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
                    Stops this client&apos;s active session without hiding or deleting routes,
                    credentials, cached content, settings, or remote data.
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!availability.canDisconnect || working}
                  onClick={() => void onDisconnect()}
                >
                  Disconnect
                </Button>
              </div>
            </section>

            <section className="space-y-4 rounded-xl border border-destructive/30 bg-card/35 p-4">
              <div>
                <h2 className="font-medium text-destructive">Fully remove</h2>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Remove from this client is required. It closes local activity and clears this
                  environment&apos;s routes, credentials, cache, UI state, and catalog metadata in a
                  crash-recoverable order.
                </p>
              </div>

              {offline ? (
                <Alert variant="warning">
                  <AlertTriangleIcon aria-hidden />
                  <AlertTitle>Remote consequences cannot be verified</AlertTitle>
                  <AlertDescription>
                    <ul className="list-disc space-y-1 pl-4">
                      {OFFLINE_FORCE_WARNINGS.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                    <strong>Remote uninstall or purge will not run now or later.</strong>
                  </AlertDescription>
                </Alert>
              ) : (
                <div className="space-y-3">
                  <label className="flex items-start gap-2 rounded-lg border border-border/70 p-3">
                    <Checkbox
                      aria-label="Uninstall BiBCode Server"
                      checked={uninstallServer}
                      disabled={!availability.canUninstall || working}
                      onCheckedChange={(checked) => setUninstallServer(checked)}
                    />
                    <span className="text-sm">
                      <span className="font-medium">Uninstall BiBCode Server</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        Removes the managed service and binary. Server data is preserved.
                      </span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2 rounded-lg border border-destructive/30 p-3">
                    <Checkbox
                      aria-label="Delete remote data, projects, and worktrees"
                      checked={purgeRemoteData}
                      disabled={!availability.canPurge || working}
                      onCheckedChange={(checked) => {
                        setPurgeRemoteData(checked);
                        if (checked) setUninstallServer(true);
                      }}
                    />
                    <span className="text-sm">
                      <span className="font-medium text-destructive">
                        Delete remote data, projects, and worktrees
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        Destructive and irreversible. Keep data is recommended.
                      </span>
                    </span>
                  </label>
                  {availability.remoteActionReason ? (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/45 p-3 text-xs text-muted-foreground">
                      <span>{availability.remoteActionReason}</span>
                      {context.hostAuthorityAvailable ? (
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={working}
                          onClick={() => void onRequestFreshPlan()}
                        >
                          Fetch fresh plan
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              )}

              {context.plan !== null ? (
                <div className="rounded-lg border border-border/70 p-3 text-xs">
                  <h3 className="font-medium">Verified remote removal plan</h3>
                  <dl className="mt-2 grid gap-1 text-muted-foreground sm:grid-cols-2">
                    <div>Data root: {context.plan.dataRoot}</div>
                    <div>Storage identity: {context.plan.storageId}</div>
                    <div>Projects: {context.plan.projectCount}</div>
                    <div>Worktrees: {context.plan.worktreeCount}</div>
                    <div>Running processes: {context.plan.processCount}</div>
                    <div>Other paired clients: {context.plan.otherPairedClientCount}</div>
                  </dl>
                </div>
              ) : null}

              {offline || purgeRemoteData ? (
                <label className="block text-xs font-medium text-muted-foreground">
                  Type <strong className="text-foreground">{context.alias}</strong> exactly
                  <Input
                    className="mt-1"
                    aria-label="Confirm environment alias"
                    value={typedAlias}
                    disabled={working}
                    onChange={(event) => setTypedAlias(event.target.value)}
                  />
                </label>
              ) : null}

              {offline ? (
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    aria-label="Force remove from this client"
                    checked={forceRemoveConfirmed}
                    disabled={working}
                    onCheckedChange={setForceRemoveConfirmed}
                  />
                  I understand the remote outcome will be unknown. Force remove from this client.
                </label>
              ) : null}

              {!validation.valid ? (
                <p className="text-xs text-destructive" role="status">
                  {validation.reason}
                </p>
              ) : null}
              {outcome !== null ? (
                <Alert variant={outcome.status === "removed" ? "success" : "error"}>
                  <AlertTitle>
                    {outcome.status === "removed" ? "Removal complete" : "Removal incomplete"}
                  </AlertTitle>
                  <AlertDescription>{outcome.message}</AlertDescription>
                </Alert>
              ) : null}

              <div className="flex justify-end">
                <Button
                  variant="destructive"
                  disabled={!validation.valid || working}
                  onClick={() => void remove()}
                >
                  <Trash2Icon className="size-3.5" aria-hidden />
                  {offline
                    ? "Force remove from this client"
                    : purgeRemoteData
                      ? "Delete remote data and remove"
                      : uninstallServer
                        ? "Uninstall server and remove"
                        : "Remove from this client"}
                </Button>
              </div>
            </section>
          </>
        )}
      </div>
    </main>
  );
}
