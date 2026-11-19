import { squashAtomCommandFailure } from "@bibcode/client-runtime/state/runtime";
import { PullRequestsOperationError } from "@bibcode/contracts";
import * as Schema from "effect/Schema";
import { useContext, useEffect, type ReactNode } from "react";
import type { EnvironmentQueryView } from "../../../state/query";
import { LoadingState, RefreshRegion } from "../../ui/loading-state";
import { Skeleton } from "../../ui/skeleton";
import { PullRequestsContextRefresh } from "../pullRequestsContextRefresh";
import { PermissionButton } from "../../ui/permission-button";
const isOperationError = Schema.is(PullRequestsOperationError);

export function PullRequestsQueryState({
  query,
  label,
  busy,
  children,
}: {
  query: EnvironmentQueryView<unknown>;
  label: string;
  /**
   * Marks the shown content busy while an outer status names its reread. Its own first
   * load stays outside that region, as the loading model in `loading-state.tsx` asks.
   */
  busy?: boolean | undefined;
  children: ReactNode;
}) {
  const failure =
    query.emission._tag === "Failure" ? squashAtomCommandFailure(query.emission) : null;
  const error = isOperationError(failure) ? failure : null;
  const refreshContext = useContext(PullRequestsContextRefresh);
  useEffect(() => {
    if (error?.code === "not_authenticated") refreshContext?.();
  }, [error, refreshContext]);
  const message = error?.message ?? query.error;
  const alert = (
    <div role="alert" className="space-y-3 p-4 text-sm">
      <p>{message}</p>
      {error?.hostDetail ? <p className="text-muted-foreground">{error.hostDetail}</p> : null}
      <PermissionButton
        permission={{ allowed: !query.isPending, reason: query.isPending ? "Loading…" : null }}
        onClick={query.refresh}
        variant="outline"
        size="sm"
      >
        Retry
      </PermissionButton>
    </div>
  );
  if (message !== null && query.data === null) return alert;
  if (query.data === null)
    return (
      <LoadingState label={`Loading ${label}…`}>
        <Skeleton className="h-16 w-full" />
      </LoadingState>
    );
  const content =
    busy === undefined ? (
      children
    ) : (
      <RefreshRegion className="flex min-h-0 min-w-0 flex-1 flex-col" refreshing={busy}>
        {children}
      </RefreshRegion>
    );
  return message === null ? (
    content
  ) : (
    <>
      {alert}
      {content}
    </>
  );
}
