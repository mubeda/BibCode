import type { SupervisorConnectionState } from "@bibcode/client-runtime/connection";
import type { ServerConfig, SourceControlProviderKind } from "@bibcode/contracts";
import {
  resolveRepositoryModuleAvailability,
  resolveRepositoryModuleMutationsDisabledReason,
  type RepositoryModuleAvailability,
} from "../repositoryModule/repositoryModuleAvailability";

export type PullRequestsAvailability = RepositoryModuleAvailability<"pullRequestsReads">;

export const PULL_REQUESTS_DISABLED_IN_SETTINGS_MESSAGE =
  "Pull requests are turned off in Settings → Source Control.";

/** What the Pull Requests module needs from the server, shared by every host of its views. */
export const PULL_REQUESTS_CAPABILITIES = {
  label: "Pull Requests",
  readsCapability: "pullRequestsReads",
  mutationsCapability: "pullRequestsMutations",
  mutationsUnsupportedMessage: "This environment does not support Pull Requests actions.",
} as const;

export function resolvePullRequestsAvailability(
  connectionState: SupervisorConnectionState | null,
  serverConfig: ServerConfig | null,
  pullRequestsEnabled: boolean,
): PullRequestsAvailability {
  return resolveRepositoryModuleAvailability(
    PULL_REQUESTS_CAPABILITIES,
    connectionState,
    serverConfig,
    pullRequestsEnabled,
  );
}

export function resolvePullRequestsMutationsDisabledReason(
  serverConfig: ServerConfig | null,
): string | null {
  return resolveRepositoryModuleMutationsDisabledReason(PULL_REQUESTS_CAPABILITIES, serverConfig);
}

/**
 * Whether a request on this host can be shown in a thread's right panel. Transient states (a
 * disconnected environment) still open the tab, which explains them; a setting that is off or a
 * host without request details would only leave a dead-end tab.
 */
export function canOpenPullRequestInPanel(input: {
  readonly enabled: boolean;
  readonly providerKind: SourceControlProviderKind;
}): boolean {
  return (
    input.enabled && input.providerKind !== "bitbucket" && input.providerKind !== "azure-devops"
  );
}
