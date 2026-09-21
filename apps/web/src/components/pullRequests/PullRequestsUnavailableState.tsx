import { Link } from "@tanstack/react-router";
import { GitPullRequestIcon } from "lucide-react";
import { useState } from "react";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { Button } from "../ui/button";

interface PullRequestsUnavailableStateProps {
  readonly reason: string;
  readonly disabledInSettings?: boolean;
  readonly authCommand?: string | null;
  readonly installHint?: string | null;
  readonly onRescan?: () => void;
  readonly isPending?: boolean;
}
function AuthenticationCommand({ command }: { readonly command: string }) {
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <code className="block select-text break-all rounded-md border border-border bg-muted p-3 text-xs">
        {command}
      </code>
      <Button
        size="sm"
        variant="outline"
        aria-label="Copy authentication command"
        onClick={() => {
          void writeTextToClipboard(command, "authentication command").then(
            () => setCopyStatus("Copied"),
            () => setCopyStatus("Copy failed. Select and copy the command above."),
          );
        }}
      >
        Copy command
      </Button>
      {copyStatus === null ? null : (
        <p role="status" className="text-xs text-muted-foreground">
          {copyStatus}
        </p>
      )}
    </div>
  );
}
export function PullRequestsUnavailableState({
  reason,
  disabledInSettings = false,
  authCommand,
  installHint,
  onRescan,
  isPending = false,
}: PullRequestsUnavailableStateProps) {
  return (
    <section
      aria-label="Pull Requests unavailable"
      className="flex h-full flex-1 items-center justify-center p-6"
    >
      <div className="w-full max-w-lg space-y-4">
        <GitPullRequestIcon aria-hidden="true" className="size-6 text-muted-foreground" />
        <h2 className="text-base font-semibold">Pull Requests unavailable</h2>
        <p className="text-sm text-muted-foreground">{reason}</p>
        {installHint ? <p className="text-sm text-muted-foreground">{installHint}</p> : null}
        {authCommand ? <AuthenticationCommand key={authCommand} command={authCommand} /> : null}
        {disabledInSettings ? (
          <Link className="text-sm underline underline-offset-4" to="/settings/source-control">
            Open Source Control settings
          </Link>
        ) : null}
        {onRescan ? (
          <Button
            variant="outline"
            size="sm"
            disabled={isPending}
            title={isPending ? "Scanning repository context…" : undefined}
            onClick={onRescan}
          >
            Rescan
          </Button>
        ) : null}
      </div>
    </section>
  );
}
