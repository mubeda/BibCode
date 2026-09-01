// Test-only fixture support. Import through the dedicated testSupport package subpath.
import type { ExecutionEnvironmentCapabilities } from "@bibcode/contracts";

export function makeTestExecutionEnvironmentCapabilities(
  overrides: Partial<ExecutionEnvironmentCapabilities> = {},
): ExecutionEnvironmentCapabilities {
  return {
    repositoryIdentity: false,
    worktreeCatalog: false,
    worktreeCatalogRefreshReason: false,
    vcsStatusSummary: false,
    gitManagerReads: false,
    gitManagerCommitOperations: false,
    gitManagerBranchSyncOperations: false,
    gitManagerStashMergeOperations: false,
    gitManagerPartialStaging: false,
    gitManagerRewriteOperations: false,
    gitManagerTagOperations: false,
    gitManagerLiveSignal: false,
    gitManagerPullRequests: false,
    activityProtocolVersion: null,
    remoteUpdateControl: false,
    ...overrides,
  };
}
