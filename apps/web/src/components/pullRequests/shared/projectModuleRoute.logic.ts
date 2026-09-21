/** Resolve project module routes through the same physical/grouped identity as chat. */
export function projectModuleRouteProjectKey(
  pathname: string,
  routeProjectScopedKey: string | null,
  projectPhysicalKeyByScopedRef: ReadonlyMap<string, string>,
  physicalToLogicalKey: ReadonlyMap<string, string>,
): string | null {
  if (
    routeProjectScopedKey === null ||
    !/^\/project\/[^/]+\/[^/]+\/(?:git|pull-requests(?:\/\d+)?)\/?$/.test(pathname)
  )
    return null;
  const physicalKey =
    projectPhysicalKeyByScopedRef.get(routeProjectScopedKey) ?? routeProjectScopedKey;
  return physicalToLogicalKey.get(physicalKey) ?? physicalKey;
}
