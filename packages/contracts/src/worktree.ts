import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

const WORKTREE_MESSAGE_MAX_LENGTH = 2_048;
const WORKTREE_CATALOG_MAX_ENTRIES = 512;

const WorktreeMessage = TrimmedNonEmptyString.check(
  Schema.isMaxLength(WORKTREE_MESSAGE_MAX_LENGTH),
);
const NormalizedWorktreePath = TrimmedNonEmptyString;
const WorktreeLockReason = TrimmedNonEmptyString.check(
  Schema.isMaxLength(WORKTREE_MESSAGE_MAX_LENGTH),
);

export const WorktreeKey = TrimmedNonEmptyString.pipe(Schema.brand("WorktreeKey"));
export type WorktreeKey = typeof WorktreeKey.Type;

export const WorktreeRepositoryKey = TrimmedNonEmptyString.pipe(
  Schema.brand("WorktreeRepositoryKey"),
);
export type WorktreeRepositoryKey = typeof WorktreeRepositoryKey.Type;

export const WorktreeDiscoveryVisibility = Schema.Literals(["hidden", "shown"]);
export type WorktreeDiscoveryVisibility = typeof WorktreeDiscoveryVisibility.Type;

export const ProjectWorktreeDiscoveryPolicy = Schema.Struct({
  visibility: WorktreeDiscoveryVisibility.pipe(
    Schema.withDecodingDefault(Effect.succeed("hidden" as const)),
  ),
  initialPromptDismissedAt: Schema.NullOr(IsoDateTime).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  baselinePaths: Schema.Array(TrimmedNonEmptyString)
    .check(Schema.isMaxLength(WORKTREE_CATALOG_MAX_ENTRIES))
    .pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type ProjectWorktreeDiscoveryPolicy = typeof ProjectWorktreeDiscoveryPolicy.Type;

export const WorktreeCatalogInput = Schema.Struct({
  projectId: ProjectId,
});
export type WorktreeCatalogInput = typeof WorktreeCatalogInput.Type;

export const WorktreeCatalogRefreshInput = Schema.Struct({
  projectId: ProjectId,
});
export type WorktreeCatalogRefreshInput = typeof WorktreeCatalogRefreshInput.Type;

export const WorktreeDiscoveryPolicyUpdateInput = Schema.Struct({
  commandId: CommandId,
  projectId: ProjectId,
  visibility: Schema.optional(WorktreeDiscoveryVisibility),
  acknowledgeGeneration: Schema.optional(NonNegativeInt),
  dismissInitialPrompt: Schema.optional(Schema.Boolean),
});
export type WorktreeDiscoveryPolicyUpdateInput = typeof WorktreeDiscoveryPolicyUpdateInput.Type;

export const VcsWorktreeRegistrationState = Schema.Literals(["registered", "prunable"]);
export type VcsWorktreeRegistrationState = typeof VcsWorktreeRegistrationState.Type;

export const VcsWorktreeDirectoryState = Schema.Literals(["present", "missing", "unknown"]);
export type VcsWorktreeDirectoryState = typeof VcsWorktreeDirectoryState.Type;

export const AdoptedWorktreeAvailability = Schema.Literals([
  "present",
  "verification-unavailable",
  "missing-registered",
  "missing-unregistered",
  "removing",
]);
export type AdoptedWorktreeAvailability = typeof AdoptedWorktreeAvailability.Type;

export const VcsWorktreeAdoptionState = Schema.Literals(["none", "active", "archived"]);
export type VcsWorktreeAdoptionState = typeof VcsWorktreeAdoptionState.Type;

export const VcsWorktreeDescriptor = Schema.Struct({
  worktreeKey: WorktreeKey,
  path: NormalizedWorktreePath,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  head: Schema.NullOr(TrimmedNonEmptyString),
  isPrimary: Schema.Boolean,
  isBare: Schema.Boolean,
  locked: Schema.Boolean,
  lockReason: Schema.optional(WorktreeLockReason),
  registrationState: VcsWorktreeRegistrationState,
  directoryState: VcsWorktreeDirectoryState,
  adoptionState: VcsWorktreeAdoptionState,
  adoptedThreadId: Schema.optional(ThreadId),
  eligibleForAdoption: Schema.Boolean,
});
export type VcsWorktreeDescriptor = typeof VcsWorktreeDescriptor.Type;

export const VcsAdoptedWorktreeStatus = Schema.Struct({
  threadId: ThreadId,
  worktreeKey: Schema.NullOr(WorktreeKey),
  path: NormalizedWorktreePath,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  availability: AdoptedWorktreeAvailability,
  registrationState: Schema.NullOr(VcsWorktreeRegistrationState),
  locked: Schema.Boolean,
  lockReason: Schema.optional(WorktreeLockReason),
});
export type VcsAdoptedWorktreeStatus = typeof VcsAdoptedWorktreeStatus.Type;

export const VcsWorktreeCatalogDegradedReason = Schema.Literals([
  "anchor-unavailable",
  "git-unavailable",
  "git-failed",
  "timed-out",
  "malformed-output",
  "output-limit",
]);
export type VcsWorktreeCatalogDegradedReason = typeof VcsWorktreeCatalogDegradedReason.Type;

export const VcsWorktreeCatalogScanStatus = Schema.Union([
  Schema.TaggedStruct("ready", {}),
  Schema.TaggedStruct("refreshing", {}),
  Schema.TaggedStruct("degraded", {
    reason: VcsWorktreeCatalogDegradedReason,
    message: WorktreeMessage,
    failedAt: IsoDateTime,
    lastAuthoritativeAt: Schema.NullOr(IsoDateTime),
  }),
]);
export type VcsWorktreeCatalogScanStatus = typeof VcsWorktreeCatalogScanStatus.Type;

export const VcsWorktreeCatalogSnapshot = Schema.Struct({
  repositoryKey: WorktreeRepositoryKey,
  generation: NonNegativeInt,
  authoritative: Schema.Boolean,
  observedAt: IsoDateTime,
  scanStatus: VcsWorktreeCatalogScanStatus,
  worktrees: Schema.Array(VcsWorktreeDescriptor).check(
    Schema.isMaxLength(WORKTREE_CATALOG_MAX_ENTRIES),
  ),
  adoptedWorkspaces: Schema.Array(VcsAdoptedWorktreeStatus).check(
    Schema.isMaxLength(WORKTREE_CATALOG_MAX_ENTRIES),
  ),
});
export type VcsWorktreeCatalogSnapshot = typeof VcsWorktreeCatalogSnapshot.Type;

export const WorktreeAdoptionDisposition = Schema.Literals(["created", "existing", "restored"]);
export type WorktreeAdoptionDisposition = typeof WorktreeAdoptionDisposition.Type;

export const WorktreeAdoptResult = Schema.Struct({
  threadId: ThreadId,
  disposition: WorktreeAdoptionDisposition,
});
export type WorktreeAdoptResult = typeof WorktreeAdoptResult.Type;

export const WorktreeRemovalMode = Schema.Literals([
  "delete-git-worktree",
  "cleanup-stale-registration",
]);
export type WorktreeRemovalMode = typeof WorktreeRemovalMode.Type;

export const WorktreeGitOutcome = Schema.Literals([
  "not-requested",
  "removed",
  "cleaned",
  "failed",
]);
export type WorktreeGitOutcome = typeof WorktreeGitOutcome.Type;

export const WorktreeRemovalAvailability = Schema.Literals([
  "present",
  "verification-unavailable",
  "missing-registered",
  "missing-unregistered",
]);
export type WorktreeRemovalAvailability = typeof WorktreeRemovalAvailability.Type;

export const WorktreeRemovalPlanToken = TrimmedNonEmptyString.pipe(
  Schema.brand("WorktreeRemovalPlanToken"),
);
export type WorktreeRemovalPlanToken = typeof WorktreeRemovalPlanToken.Type;

export const WorktreePruneImpact = Schema.Struct({
  path: NormalizedWorktreePath,
  locked: Schema.Boolean,
  lockReason: Schema.optional(WorktreeLockReason),
});
export type WorktreePruneImpact = typeof WorktreePruneImpact.Type;

export const WorktreeRemovalPlan = Schema.Struct({
  planToken: WorktreeRemovalPlanToken,
  generation: NonNegativeInt,
  availability: WorktreeRemovalAvailability,
  registered: Schema.Boolean,
  locked: Schema.Boolean,
  lockReason: Schema.optional(WorktreeLockReason),
  trackedChangeCount: NonNegativeInt,
  untrackedFileCount: NonNegativeInt,
  pruneImpact: Schema.Array(WorktreePruneImpact).check(
    Schema.isMaxLength(WORKTREE_CATALOG_MAX_ENTRIES),
  ),
});
export type WorktreeRemovalPlan = typeof WorktreeRemovalPlan.Type;

export const WorktreeRemovalResult = Schema.Struct({
  threadRemoved: Schema.Boolean,
  gitOutcome: WorktreeGitOutcome,
  detail: Schema.optional(WorktreeMessage),
  orphanCleanupPending: Schema.Boolean,
});
export type WorktreeRemovalResult = typeof WorktreeRemovalResult.Type;

export const WorktreeCatalogErrorReason = Schema.Literals([
  "project-not-found",
  "environment-unsupported",
  "repository-unavailable",
  "stale-generation",
  "policy-update-failed",
  "internal",
]);
export type WorktreeCatalogErrorReason = typeof WorktreeCatalogErrorReason.Type;

export class WorktreeCatalogError extends Schema.TaggedErrorClass<WorktreeCatalogError>()(
  "WorktreeCatalogError",
  {
    reason: WorktreeCatalogErrorReason,
    message: WorktreeMessage,
  },
) {}

export const WorktreeAdoptionErrorReason = Schema.Literals([
  "project-not-found",
  "environment-unsupported",
  "worktree-not-found",
  "stale-generation",
  "ineligible",
  "workspace-missing",
  "repository-mismatch",
  "ownership-conflict",
  "orchestration-failed",
  "internal",
]);
export type WorktreeAdoptionErrorReason = typeof WorktreeAdoptionErrorReason.Type;

export class WorktreeAdoptionError extends Schema.TaggedErrorClass<WorktreeAdoptionError>()(
  "WorktreeAdoptionError",
  {
    reason: WorktreeAdoptionErrorReason,
    message: WorktreeMessage,
    currentGeneration: Schema.optional(NonNegativeInt),
  },
) {}

export const WorktreeRemovalErrorReason = Schema.Literals([
  "thread-not-found",
  "environment-unsupported",
  "stale-generation",
  "stale-plan",
  "dirty-confirmation-required",
  "prune-confirmation-required",
  "protected-target",
  "locked",
  "replacement-conflict",
  "repository-mismatch",
  "git-failed",
  "orchestration-failed",
  "internal",
]);
export type WorktreeRemovalErrorReason = typeof WorktreeRemovalErrorReason.Type;

export class WorktreeRemovalError extends Schema.TaggedErrorClass<WorktreeRemovalError>()(
  "WorktreeRemovalError",
  {
    reason: WorktreeRemovalErrorReason,
    message: WorktreeMessage,
    currentGeneration: Schema.optional(NonNegativeInt),
  },
) {}

export const WorkspaceUnavailableErrorReason = Schema.Literal("workspace-unavailable");
export type WorkspaceUnavailableErrorReason = typeof WorkspaceUnavailableErrorReason.Type;

export class WorkspaceUnavailableError extends Schema.TaggedErrorClass<WorkspaceUnavailableError>()(
  "WorkspaceUnavailableError",
  {
    reason: WorkspaceUnavailableErrorReason,
    message: WorktreeMessage,
    threadId: ThreadId,
    path: NormalizedWorktreePath,
    availability: AdoptedWorktreeAvailability,
  },
) {}
