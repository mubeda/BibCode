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
  /** An update BiBCode started is queued or running for this instance. */
  readonly updateActive: boolean;
  /** When the update state BiBCode retains for this instance last finished, if it did. */
  readonly updateFinishedAt: string | null;
}

/** What is remembered about an instance between two snapshots. */
export interface RememberedVersion {
  readonly version: string;
  readonly updateFinishedAt: string | null;
}

export interface ExternalUpdateNotice {
  /** One per environment, instance and version: the notice never repeats. */
  readonly key: string;
  readonly title: string;
  readonly description: string;
}

function observationKey(observation: ProviderVersionObservation): string {
  return `${observation.environmentId}:${observation.instanceId}`;
}

/**
 * The version number of a reported version string: Claude Code reports `2.1.100 (Claude Code)`,
 * which must compare as 2.1.100 and read as 2.1.100.
 */
export function cleanVersion(version: string): string {
  return (version.trim().split(/\s+/)[0] ?? "").replace(/^v/, "");
}

function advanced(previous: string, next: string): boolean {
  try {
    return compareSemverVersions(cleanVersion(next), cleanVersion(previous)) > 0;
  } catch {
    return false;
  }
}

/**
 * The notices for versions that rose since `previous` without BiBCode updating them, and what to
 * remember next time. A first sight of an instance (a fresh connect, a reload) has nothing to
 * compare with and says nothing. A rise counts as BiBCode's own only when its retained update
 * state finished in this same snapshot (or an update is running now), so one update BiBCode ran
 * earlier never hides a later automatic one.
 */
export function detectExternalUpdates(
  previous: ReadonlyMap<string, RememberedVersion>,
  observations: ReadonlyArray<ProviderVersionObservation>,
  announced: ReadonlySet<string>,
  multipleEnvironments: boolean,
): {
  readonly notices: ReadonlyArray<ExternalUpdateNotice>;
  readonly next: ReadonlyMap<string, RememberedVersion>;
} {
  const next = new Map(previous);
  const notices: ExternalUpdateNotice[] = [];
  for (const observation of observations) {
    if (observation.version === null) {
      continue;
    }
    const key = observationKey(observation);
    const before = previous.get(key);
    next.set(key, {
      version: observation.version,
      updateFinishedAt: observation.updateFinishedAt,
    });
    if (
      before === undefined ||
      !EXTERNAL_UPDATE_NOTICE_DRIVERS.has(observation.driver) ||
      !advanced(before.version, observation.version)
    ) {
      continue;
    }
    const updatedByBiBCode =
      observation.updateActive ||
      (observation.updateFinishedAt !== null &&
        observation.updateFinishedAt !== before.updateFinishedAt);
    if (updatedByBiBCode) {
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
      }It updated itself. New sessions use it; running sessions keep ${cleanVersion(before.version)} until they restart.`,
    });
  }
  return { notices, next };
}
