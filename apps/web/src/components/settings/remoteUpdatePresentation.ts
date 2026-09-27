import type { RemoteUpdateActiveWork, RemoteUpdateSnapshot } from "@bibcode/contracts";
import {
  isRemoteUpdateRunActive,
  type RemoteUpdateFailure,
  type RemoteUpdateRunState,
} from "@bibcode/client-runtime/state/remoteUpdateCoordinator";
import { compareSemverVersions } from "@bibcode/shared/semver";

export interface RemoteUpdateConfirmationInput {
  readonly name: string;
  readonly targetVersion: string | null;
  /** Null when the server cannot count or the read failed. */
  readonly activeWork: RemoteUpdateActiveWork | null;
  readonly counting: boolean;
  readonly appVersion: string;
}

export interface RemoteUpdateConfirmation {
  readonly title: string;
  readonly lines: ReadonlyArray<string>;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
}

const KEPT =
  "Conversations and queued messages are kept, and agents continue when you send the next message.";
const PROTECTION_STAGES = new Set([
  "waiting-for-mutations",
  "quiescing-runtime",
  "acquiring-store-lock",
  "checkpointing-database",
  "creating-verified-backup",
]);

export function remoteUpdateActionLabel(latestVersion: string): string {
  return `Update to v${latestVersion}…`;
}

function workLine(activeWork: RemoteUpdateActiveWork | null): string {
  if (activeWork === null) return `Running agents and terminals on it will stop. ${KEPT}`;
  const parts: string[] = [];
  if (activeWork.runningTurns > 0) {
    parts.push(
      `${activeWork.runningTurns} running agent${activeWork.runningTurns === 1 ? "" : "s"}`,
    );
  }
  if (activeWork.liveTerminals > 0) {
    parts.push(`${activeWork.liveTerminals} terminal${activeWork.liveTerminals === 1 ? "" : "s"}`);
  }
  return parts.length === 0
    ? "Nothing is running on it now."
    : `${parts.join(" and ")} will stop. ${KEPT}`;
}

export function remoteUpdateConfirmation(
  input: RemoteUpdateConfirmationInput,
): RemoteUpdateConfirmation {
  const lines = [
    `Updating ${input.name} restarts BiBCode there.`,
    input.counting ? "Counting running work…" : workLine(input.activeWork),
  ];
  if (
    input.targetVersion !== null &&
    compareSemverVersions(input.targetVersion, input.appVersion) > 0
  ) {
    lines.push(
      `v${input.targetVersion} is newer than this app (v${input.appVersion}). Update this app too.`,
    );
  }
  return {
    title:
      input.targetVersion === null
        ? `Update ${input.name}?`
        : `Update ${input.name} to v${input.targetVersion}?`,
    lines,
    confirmLabel: `Update ${input.name}`,
    cancelLabel: "Cancel",
  };
}

export function remoteUpdateInstallStageLabel(stage: string | null): string {
  if (stage !== null && PROTECTION_STAGES.has(stage)) return "Backing up project data…";
  if (stage === "stopping-backend" || stage === "installing") return "Restarting…";
  return "Updating…";
}

export function remoteUpdateProgressLabel(run: RemoteUpdateRunState): string | null {
  switch (run.phase) {
    case "queued":
      return "Queued";
    case "starting":
      return "Updating…";
    case "downloading":
      return run.percent === null ? "Downloading…" : `Downloading ${Math.floor(run.percent)}%`;
    case "installing":
      return remoteUpdateInstallStageLabel(run.stage);
    case "restarting":
      return "Restarting…";
    case "verifying":
      return "Checking the new version…";
    case "succeeded":
      return `Updated to v${run.version}`;
    case "up-to-date":
      return "Already up to date";
    case "failed":
      return null;
  }
}

function sentence(text: string): string {
  return /[.!?]$/u.test(text) ? text : `${text}.`;
}

export function remoteUpdateFailureMessage(name: string, failure: RemoteUpdateFailure): string {
  switch (failure.kind) {
    case "host-error":
      return failure.runningVersion === "unknown"
        ? `Couldn't update ${name}: ${sentence(failure.message)} Nothing was installed.`
        : `Couldn't update ${name}: ${sentence(failure.message)} Nothing was installed; it runs v${failure.runningVersion} again.`;
    case "not-back":
      return `${name} hasn't come back after the update. Check BiBCode on ${name}; it may be on a different port.`;
    case "wrong-version":
      return `${name} restarted on v${failure.runningVersion} instead of v${failure.targetVersion}.`;
    case "manual-required":
      return `Couldn't update ${name}: this server must be updated manually.`;
    case "install-timeout":
      return `${name} is taking longer than 2 minutes to install ${failure.targetVersion === null ? "the update" : `v${failure.targetVersion}`}. Check BiBCode on ${name}.`;
    case "blocked":
      return `Can't reconnect to ${name} after the update: ${sentence(failure.message)}`;
  }
}

export function remoteUpdateSuccessTitle(name: string, version: string): string {
  return `${name} updated to v${version}`;
}

export function remoteUpdateUpToDateTitle(name: string): string {
  return `${name} is already up to date`;
}

/** Hide settled feedback only when the snapshot catches up; keep the coordinator's state intact. */
export function visibleRemoteUpdateRun(
  run: RemoteUpdateRunState | null,
  snapshot: RemoteUpdateSnapshot | null | undefined,
): RemoteUpdateRunState | null {
  if (run === null || isRemoteUpdateRunActive(run) || run.phase === "failed") return run;
  if (
    run.phase === "succeeded" &&
    snapshot != null &&
    compareSemverVersions(snapshot.serverVersion, run.version) >= 0
  ) {
    return null;
  }
  if (run.phase === "up-to-date" && snapshot?.state === "up-to-date") return null;
  return run;
}
