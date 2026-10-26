/** Git Manager, Pull Requests (list, request) and Pipelines (list, pipeline, job). */
const PROJECT_MODULE_ROUTE =
  /^\/project\/[^/]+\/[^/]+\/(?:git|pull-requests(?:\/\d+)?|pipelines(?:\/\d+(?:\/jobs\/\d+)?)?)\/?$/;

/** Resolve project module routes through the same physical/grouped identity as chat. */
export function projectModuleRouteProjectKey(
  pathname: string,
  routeProjectScopedKey: string | null,
  projectPhysicalKeyByScopedRef: ReadonlyMap<string, string>,
  physicalToLogicalKey: ReadonlyMap<string, string>,
): string | null {
  if (routeProjectScopedKey === null || !PROJECT_MODULE_ROUTE.test(pathname)) return null;
  const physicalKey =
    projectPhysicalKeyByScopedRef.get(routeProjectScopedKey) ?? routeProjectScopedKey;
  return physicalToLogicalKey.get(physicalKey) ?? physicalKey;
}
