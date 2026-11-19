import type { EnvironmentId } from "@bibcode/contracts";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import { useEnvironment } from "~/state/environments";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

import { serverDisplayLabel } from "./serverCommands";

/** How long a restored URL waits for its server to be registered before saying it is gone. */
export const MISSING_SERVER_NOTICE_DELAY_MS = 3_000;

/**
 * The header and body of a server's center panel. After a reload the catalog can be ready
 * before a local server registers, so a missing server never redirects: the panel waits,
 * then says the server is not available, and shows it as soon as it appears.
 */
export function ServerPanelFrame({
  environmentId,
  title,
  testId,
  children,
}: {
  readonly environmentId: EnvironmentId;
  readonly title: string;
  readonly testId: string;
  readonly children: ReactNode;
}) {
  const environment = useEnvironment(environmentId);
  const missing = environment === null;
  const [noticeDue, setNoticeDue] = useState(false);

  useEffect(() => {
    if (!missing) return;
    const timeoutId = window.setTimeout(() => setNoticeDue(true), MISSING_SERVER_NOTICE_DELAY_MS);
    return () => window.clearTimeout(timeoutId);
  }, [missing]);

  if (environment === null) {
    return noticeDue ? (
      <div
        role="status"
        data-testid={`${testId}-missing`}
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground"
      >
        <p>This server is not available. It may have been removed from this device.</p>
        <Link to="/settings/remote-servers" className="text-foreground underline">
          Open Remote Servers
        </Link>
      </div>
    ) : null;
  }
  return (
    <div data-testid={testId} className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <header
        className={cn(
          "workspace-topbar flex shrink-0 items-center gap-2 border-b border-panel-separator px-3 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
          COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
      >
        <h1 className="min-w-0 truncate text-sm font-medium text-foreground">
          {serverDisplayLabel(environment)}
        </h1>
        <span className="shrink-0 text-muted-foreground text-xs">{title}</span>
      </header>
      {children}
    </div>
  );
}
