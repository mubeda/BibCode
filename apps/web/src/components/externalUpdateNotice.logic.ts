import type { EnvironmentId } from "@bibcode/contracts";
import { compareSemverVersions } from "@bibcode/shared/semver";

/**
 * Drivers whose own updater can move the installed version while BiBCode runs. Claude Code
 * updates itself in the background, so BiBCode usually sees it current and would otherwise
 * never say that it changed.
 */
export const EXTERNAL_UPDATE_NOTICE_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent"]);

export interface ProviderVersionObservation {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: string;
  readonly driver: string;
  readonly displayName: string;
  readonly version: string | null;
  /** BiBCode ran or is running an update for this instance, so its own toast reports it. */
  readonly updatedByBiBCode: boolean;
}

export interface ExternalUpdateNotice {
  /** One per environment, instance and version: the toast never repeats. */
  readonly key: string;
  readonly title: string;
  readonly description: string;
}

function observationKey(observation: ProviderVersionObservation): string {
  return `${observation.environmentId}:${observation.instanceId}`;
}

function cleanVersion(version: string): string {
  return version.replace(/^v/, "");
}

function advanced(previous: string, next: string): boolean {
  try {
    return compareSemverVersions(cleanVersion(next), cleanVersion(previous)) > 0;
  } catch {
    return false;
  }
}

/**
 * The notices for versions that rose since `previous` without BiBCode updating them, and the
 * versions to remember next time. A first sight of an instance (a fresh connect, a reload)
 * has nothing to compare with and says nothing.
 */
export function detectExternalUpdates(
  previous: ReadonlyMap<string, string>,
  observations: ReadonlyArray<ProviderVersionObservation>,
  announced: ReadonlySet<string>,
  multipleEnvironments: boolean,
): {
  readonly notices: ReadonlyArray<ExternalUpdateNotice>;
  readonly next: ReadonlyMap<string, string>;
} {
  const next = new Map(previous);
  const notices: ExternalUpdateNotice[] = [];
  for (const observation of observations) {
    if (observation.version === null) {
      continue;
    }
    const key = observationKey(observation);
    const before = previous.get(key);
    next.set(key, observation.version);
    if (
      before === undefined ||
      !EXTERNAL_UPDATE_NOTICE_DRIVERS.has(observation.driver) ||
      observation.updatedByBiBCode ||
      !advanced(before, observation.version)
    ) {
      continue;
    }
    const noticeKey = `external:${key}:${cleanVersion(observation.version)}`;
    if (announced.has(noticeKey)) {
      continue;
    }
    notices.push({
      key: noticeKey,
      title: `${observation.displayName} updated to ${cleanVersion(observation.version)}`,
      description: `${
        multipleEnvironments ? `${observation.environmentLabel}: ` : ""
      }It updated itself. New sessions use it; running sessions keep ${cleanVersion(before)} until they restart.`,
    });
  }
  return { notices, next };
}
