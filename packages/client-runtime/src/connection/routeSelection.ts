import type { KnownEnvironment } from "./catalog.ts";
import type { EnvironmentRoute } from "./model.ts";

export interface EnvironmentRouteSelectionOptions {
  /** Last route that completed identity verification and still owns the live lease. */
  readonly activeRouteId: string | null;
  /** Routes requiring explicit user action before they may be attempted again. */
  readonly blockedRouteIds?: ReadonlySet<string>;
}

/**
 * Returns the deterministic, sequential attempt order for one environment.
 * The catalog order is presentation state; connection policy never mutates it.
 */
export function eligibleRoutes(
  environment: KnownEnvironment,
  options: EnvironmentRouteSelectionOptions,
): ReadonlyArray<EnvironmentRoute> {
  const pinnedRouteId = environment.routes.find((route) => route.pinned)?.routeId ?? null;
  const blockedRouteIds = options.blockedRouteIds ?? new Set<string>();

  return environment.routes
    .filter(
      (route) =>
        !blockedRouteIds.has(route.routeId) &&
        (route.autoconnect || route.routeId === pinnedRouteId),
    )
    .toSorted(
      (left, right) =>
        Number(right.routeId === pinnedRouteId) - Number(left.routeId === pinnedRouteId) ||
        Number(right.routeId === options.activeRouteId) -
          Number(left.routeId === options.activeRouteId) ||
        left.priority - right.priority ||
        left.routeId.localeCompare(right.routeId),
    );
}

export function selectRoute(
  environment: KnownEnvironment,
  options: EnvironmentRouteSelectionOptions,
): EnvironmentRoute | undefined {
  return eligibleRoutes(environment, options)[0];
}
