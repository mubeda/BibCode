export interface ServerBoot {
  readonly bootId: string | null;
  readonly serverVersion: string;
}

/** Offers a reload only after this page's server restarts onto another bundle version. */
export function serverReloadVersion(input: {
  readonly desktop: boolean;
  readonly bundleVersion: string;
  readonly firstBoot: ServerBoot | null;
  readonly current: ServerBoot | null;
}): string | null {
  const { desktop, bundleVersion, firstBoot, current } = input;
  if (desktop || firstBoot === null || current === null) return null;
  if (firstBoot.bootId === null || current.bootId === null || firstBoot.bootId === current.bootId)
    return null;
  return current.serverVersion === bundleVersion ? null : current.serverVersion;
}
