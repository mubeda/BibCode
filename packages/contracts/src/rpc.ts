import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import { ExternalLauncherError, LaunchEditorInput } from "./editor.ts";
import { AuthAccessStreamError, AuthAccessStreamEvent, EnvironmentRpcError } from "./auth.ts";
import {
  ActivityCancelSubtreeInput,
  ActivityDetailPage,
  ActivityError,
  ActivityGetSnapshotInput,
  ActivityListDetailInput,
  ActivityListRosterInput,
  ActivityRosterPage,
  ActivityRetrySubtreeCancellationInput,
  ActivityScopeRef,
  ActivitySnapshot,
  ActivityStreamItem,
  ActivitySubtreeCancellationResult,
} from "./activity.ts";
import {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  FilesystemBrowseError,
} from "./filesystem.ts";
import { AssetAccessError, AssetCreateUrlInput, AssetCreateUrlResult } from "./assets.ts";
import {
  GitActionProgressEvent,
  VcsSwitchRefInput,
  VcsSwitchRefResult,
  GitCommandError,
  VcsCreateRefInput,
  VcsCreateRefResult,
  GitCloneInput,
  GitCloneResult,
  VcsDiscardFilesInput,
  VcsGenerateCommitMessageInput,
  VcsGenerateCommitMessageResult,
  VcsInitInput,
  VcsListCommitsInput,
  VcsListCommitsResult,
  VcsListRefsInput,
  VcsListRefsResult,
  GitManagerServiceError,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  VcsPullInput,
  GitPullRequestRefInput,
  VcsPullResult,
  GitResolvePullRequestResult,
  GitRunStackedActionInput,
  VcsStageFilesInput,
  VcsStatusInput,
  VcsStatusResult,
  VcsStatusStreamEvent,
  VcsUnstageFilesInput,
} from "./git.ts";
import {
  ReviewDiffPreviewError,
  ReviewDiffPreviewInput,
  ReviewDiffPreviewResult,
} from "./review.ts";
import { KeybindingsConfigError } from "./keybindings.ts";
import {
  ClientOrchestrationCommand,
  ModelSelection,
  ORCHESTRATION_WS_METHODS,
  OrchestrationDispatchCommandError,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetSnapshotError,
  OrchestrationGetTurnDiffError,
  OrchestrationGetTurnDiffInput,
  OrchestrationReplayEventsError,
  OrchestrationReplayEventsInput,
  OrchestrationRpcSchemas,
  ProviderInteractionMode,
  RuntimeMode,
} from "./orchestration.ts";
import {
  CommandId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { RemoteUpdateInstallError, RemoteUpdateSnapshot } from "./remoteUpdate.ts";
import {
  RelayClientInstallFailedError,
  RelayClientInstallProgressEventSchema,
  RelayClientStatusSchema,
} from "./relayClient.ts";
import {
  ProjectCreateEntryError,
  ProjectCreateEntryInput,
  ProjectCreateEntryResult,
  ProjectDeleteEntryError,
  ProjectDeleteEntryInput,
  ProjectDeleteEntryResult,
  ProjectDuplicateEntryError,
  ProjectDuplicateEntryInput,
  ProjectDuplicateEntryResult,
  ProjectEntriesChangedEvent,
  ProjectListEntriesError,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectReadFileError,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectRenameEntryError,
  ProjectRenameEntryInput,
  ProjectRenameEntryResult,
  ProjectSearchEntriesError,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectSubscribeEntriesInput,
  ProjectWriteFileError,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project.ts";
import {
  TerminalAttachInput,
  TerminalAttachStreamEvent,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalError,
  TerminalEvent,
  TerminalMetadataStreamEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal.ts";
import {
  DiscoveredLocalServerList,
  PreviewCloseInput,
  PreviewError,
  PreviewEvent,
  PreviewListInput,
  PreviewListResult,
  PreviewNavigateInput,
  PreviewOpenInput,
  PreviewRefreshInput,
  PreviewReportStatusInput,
  PreviewResizeInput,
  PreviewSessionSnapshot,
} from "./preview.ts";
import {
  PreviewAutomationError,
  PreviewAutomationHost,
  PreviewAutomationHostFocus,
  PreviewAutomationResponse,
  PreviewAutomationStreamEvent,
} from "./previewAutomation.ts";
import {
  ServerConfigStreamEvent,
  ServerConfig,
  ServerProviderUpdateError,
  ServerProviderUpdateInput,
  ServerLifecycleStreamEvent,
  ServerRemoveKeybindingInput,
  ServerRemoveKeybindingResult,
  ServerProviderUpdatedPayload,
  ServerTraceDiagnosticsResult,
  ServerProcessDiagnosticsResult,
  ServerProcessResourceHistoryInput,
  ServerProcessResourceHistoryResult,
  ServerSignalProcessInput,
  ServerSignalProcessResult,
  ServerUpsertKeybindingInput,
  ServerUpsertKeybindingResult,
} from "./server.ts";
import {
  ConsumeCodexRateLimitResetInput,
  ConsumeCodexRateLimitResetResult,
  ServerProviderUsageRefreshInput,
  ServerProviderUsageResetError,
  ServerProviderUsageResult,
} from "./providerUsage.ts";
import {
  ServerSettings,
  ServerSettingsError,
  ServerSettingsPatch,
  WorktreeWorkspaceError,
} from "./settings.ts";
import {
  SourceControlCloneRepositoryInput,
  SourceControlCloneRepositoryResult,
  SourceControlDiscoveryResult,
  SourceControlPublishRepositoryInput,
  SourceControlPublishRepositoryResult,
  SourceControlRepositoryError,
  SourceControlRepositoryInfo,
  SourceControlRepositoryLookupInput,
} from "./sourceControl.ts";
import { VcsError, VcsStatusSummary } from "./vcs.ts";
import {
  ProjectWorktreeDiscoveryPolicy,
  VcsWorktreeCatalogSnapshot,
  WorktreeCatalogError,
  WorktreeCatalogInput,
  WorktreeCatalogRefreshInput,
  WorktreeDiscoveryPolicyUpdateInput,
  WorktreeAdoptResult,
  WorktreeAdoptionError,
  WorktreeKey,
  WorktreeOperationError,
  WorktreeRemovalError,
  WorktreeRemovalMode,
  WorktreeRemovalPlan,
  WorktreeRemovalPlanToken,
  WorktreeRemovalResult,
  WorkspaceIdentityError,
  WorkspaceUnavailableError,
} from "./worktree.ts";

export const WorktreeAdoptInput = Schema.Struct({
  commandId: CommandId,
  projectId: ProjectId,
  worktreeKey: WorktreeKey,
  expectedGeneration: NonNegativeInt,
  threadDefaults: Schema.Struct({
    modelSelection: ModelSelection,
    runtimeMode: RuntimeMode,
    interactionMode: ProviderInteractionMode,
  }),
});
export type WorktreeAdoptInput = typeof WorktreeAdoptInput.Type;

const WorktreeThreadDefaults = Schema.Struct({
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});

export const WorktreeCreateManagedInput = Schema.Struct({
  commandId: CommandId,
  projectId: ProjectId,
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  refName: TrimmedNonEmptyString,
  newRefName: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  baseRefName: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  threadDefaults: WorktreeThreadDefaults,
});
export type WorktreeCreateManagedInput = typeof WorktreeCreateManagedInput.Type;

export const WorktreeCreatePanelInput = Schema.Struct({
  commandId: CommandId,
  hostThreadId: ThreadId,
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  threadDefaults: WorktreeThreadDefaults,
});
export type WorktreeCreatePanelInput = typeof WorktreeCreatePanelInput.Type;

export const WorktreeRetargetInput = Schema.Struct({
  commandId: CommandId,
  projectId: ProjectId,
  threadId: ThreadId,
  worktreeKey: WorktreeKey,
  expectedGeneration: NonNegativeInt,
});
export type WorktreeRetargetInput = typeof WorktreeRetargetInput.Type;

export const WorktreeThreadResult = Schema.Struct({
  threadId: ThreadId,
});
export type WorktreeThreadResult = typeof WorktreeThreadResult.Type;

export const WorktreeManagedCreateResult = Schema.Struct({
  threadId: ThreadId,
  path: TrimmedNonEmptyString,
  refName: TrimmedNonEmptyString,
});
export type WorktreeManagedCreateResult = typeof WorktreeManagedCreateResult.Type;

export const WorktreeGetRemovalPlanInput = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
});
export type WorktreeGetRemovalPlanInput = typeof WorktreeGetRemovalPlanInput.Type;

export const WorktreeRemoveFromBibCodeInput = Schema.Struct({
  commandId: CommandId,
  projectId: ProjectId,
  threadId: ThreadId,
});
export type WorktreeRemoveFromBibCodeInput = typeof WorktreeRemoveFromBibCodeInput.Type;

export const WorktreeRemoveInput = Schema.Struct({
  commandId: CommandId,
  projectId: ProjectId,
  threadId: ThreadId,
  mode: WorktreeRemovalMode,
  expectedGeneration: NonNegativeInt,
  planToken: WorktreeRemovalPlanToken,
  forceDirty: Schema.Boolean,
  confirmRepositoryWidePrune: Schema.Boolean,
});
export type WorktreeRemoveInput = typeof WorktreeRemoveInput.Type;

export const WS_METHODS = {
  // Project registry methods
  projectsList: "projects.list",
  projectsAdd: "projects.add",
  projectsRemove: "projects.remove",
  projectsListEntries: "projects.listEntries",
  projectsSubscribeEntries: "subscribeProjectEntries",
  projectsReadFile: "projects.readFile",
  projectsSearchEntries: "projects.searchEntries",
  projectsWriteFile: "projects.writeFile",
  projectsCreateEntry: "projects.createEntry",
  projectsRenameEntry: "projects.renameEntry",
  projectsDeleteEntry: "projects.deleteEntry",
  projectsDuplicateEntry: "projects.duplicateEntry",

  // Shell methods
  shellOpenInEditor: "shell.openInEditor",

  // Filesystem methods
  filesystemBrowse: "filesystem.browse",
  assetsCreateUrl: "assets.createUrl",

  // VCS methods
  vcsPull: "vcs.pull",
  vcsRefreshStatus: "vcs.refreshStatus",
  vcsListRefs: "vcs.listRefs",
  vcsListCommits: "vcs.listCommits",
  vcsClone: "vcs.clone",
  vcsCreateRef: "vcs.createRef",
  vcsSwitchRef: "vcs.switchRef",
  vcsInit: "vcs.init",
  vcsStageFiles: "vcs.stageFiles",
  vcsUnstageFiles: "vcs.unstageFiles",
  vcsDiscardFiles: "vcs.discardFiles",
  vcsGenerateCommitMessage: "vcs.generateCommitMessage",
  vcsRefreshWorktreeCatalog: "vcs.refreshWorktreeCatalog",
  worktreeUpdateDiscoveryPolicy: "worktree.updateDiscoveryPolicy",
  worktreeAdopt: "worktree.adopt",
  worktreeCreateManaged: "worktree.createManaged",
  worktreeCreatePanel: "worktree.createPanel",
  worktreeRetarget: "worktree.retarget",
  worktreeGetRemovalPlan: "worktree.getRemovalPlan",
  worktreeRemoveFromBibCode: "worktree.removeFromBibCode",
  worktreeRemove: "worktree.remove",

  // Git workflow methods
  gitRunStackedAction: "git.runStackedAction",
  gitResolvePullRequest: "git.resolvePullRequest",
  gitPreparePullRequestThread: "git.preparePullRequestThread",

  // Review methods
  reviewGetDiffPreview: "review.getDiffPreview",

  // Activity methods
  activityGetSnapshot: "activity.getSnapshot",
  activityListRoster: "activity.listRoster",
  activityListDetail: "activity.listDetail",
  activityCancelSubtree: "activity.cancelSubtree",
  activityRetrySubtreeCancellation: "activity.retrySubtreeCancellation",

  // Terminal methods
  terminalOpen: "terminal.open",
  terminalAttach: "terminal.attach",
  terminalWrite: "terminal.write",
  terminalResize: "terminal.resize",
  terminalClear: "terminal.clear",
  terminalRestart: "terminal.restart",
  terminalClose: "terminal.close",

  // Preview methods
  previewOpen: "preview.open",
  previewNavigate: "preview.navigate",
  previewResize: "preview.resize",
  previewRefresh: "preview.refresh",
  previewClose: "preview.close",
  previewList: "preview.list",
  previewReportStatus: "preview.reportStatus",
  previewAutomationConnect: "previewAutomation.connect",
  previewAutomationRespond: "previewAutomation.respond",
  previewAutomationFocusHost: "previewAutomation.focusHost",

  // Server meta
  serverGetConfig: "server.getConfig",
  serverRefreshProviders: "server.refreshProviders",
  serverUpdateProvider: "server.updateProvider",
  serverUpsertKeybinding: "server.upsertKeybinding",
  serverRemoveKeybinding: "server.removeKeybinding",
  serverGetSettings: "server.getSettings",
  serverUpdateSettings: "server.updateSettings",
  serverDiscoverSourceControl: "server.discoverSourceControl",
  serverGetTraceDiagnostics: "server.getTraceDiagnostics",
  serverGetProcessDiagnostics: "server.getProcessDiagnostics",
  serverGetProcessResourceHistory: "server.getProcessResourceHistory",
  serverSignalProcess: "server.signalProcess",
  serverGetProviderUsage: "server.getProviderUsage",
  serverRefreshProviderUsage: "server.refreshProviderUsage",
  serverConsumeCodexRateLimitReset: "server.consumeCodexRateLimitReset",

  // Remote updater methods
  updaterStatus: "updater.status",
  updaterCheck: "updater.check",
  updaterInstall: "updater.install",

  // Cloud environment methods
  cloudGetRelayClientStatus: "cloud.getRelayClientStatus",
  cloudInstallRelayClient: "cloud.installRelayClient",

  // Source control methods
  sourceControlLookupRepository: "sourceControl.lookupRepository",
  sourceControlCloneRepository: "sourceControl.cloneRepository",
  sourceControlPublishRepository: "sourceControl.publishRepository",

  // Streaming subscriptions
  subscribeVcsStatus: "subscribeVcsStatus",
  subscribeVcsStatusSummary: "subscribeVcsStatusSummary",
  subscribeTerminalEvents: "subscribeTerminalEvents",
  subscribeTerminalMetadata: "subscribeTerminalMetadata",
  subscribePreviewEvents: "subscribePreviewEvents",
  subscribeDiscoveredLocalServers: "subscribeDiscoveredLocalServers",
  subscribeServerConfig: "subscribeServerConfig",
  subscribeServerLifecycle: "subscribeServerLifecycle",
  subscribeAuthAccess: "subscribeAuthAccess",
  subscribeActivity: "subscribeActivity",
  subscribeWorktreeCatalog: "subscribeWorktreeCatalog",
} as const;

export const WsServerUpsertKeybindingRpc = Rpc.make(WS_METHODS.serverUpsertKeybinding, {
  payload: ServerUpsertKeybindingInput,
  success: ServerUpsertKeybindingResult,
  error: Schema.Union([KeybindingsConfigError, EnvironmentRpcError]),
});

export const WsServerRemoveKeybindingRpc = Rpc.make(WS_METHODS.serverRemoveKeybinding, {
  payload: ServerRemoveKeybindingInput,
  success: ServerRemoveKeybindingResult,
  error: Schema.Union([KeybindingsConfigError, EnvironmentRpcError]),
});

export const WsServerGetConfigRpc = Rpc.make(WS_METHODS.serverGetConfig, {
  payload: Schema.Struct({}),
  success: ServerConfig,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError, EnvironmentRpcError]),
});

export const WsServerRefreshProvidersRpc = Rpc.make(WS_METHODS.serverRefreshProviders, {
  payload: Schema.Struct({
    /**
     * When supplied, only refresh this specific provider instance. When
     * omitted, refresh all configured instances — the legacy `refresh()`
     * behaviour retained for transports that still dispatch untargeted
     * refreshes.
     */
    instanceId: Schema.optional(ProviderInstanceId),
  }),
  success: ServerProviderUpdatedPayload,
  error: EnvironmentRpcError,
});

export const WsServerUpdateProviderRpc = Rpc.make(WS_METHODS.serverUpdateProvider, {
  payload: ServerProviderUpdateInput,
  success: ServerProviderUpdatedPayload,
  error: Schema.Union([ServerProviderUpdateError, EnvironmentRpcError]),
});

export const WsServerGetSettingsRpc = Rpc.make(WS_METHODS.serverGetSettings, {
  payload: Schema.Struct({}),
  success: ServerSettings,
  error: Schema.Union([ServerSettingsError, EnvironmentRpcError]),
});

export const WsServerUpdateSettingsRpc = Rpc.make(WS_METHODS.serverUpdateSettings, {
  payload: Schema.Struct({ patch: ServerSettingsPatch }),
  success: ServerSettings,
  error: Schema.Union([ServerSettingsError, WorktreeWorkspaceError, EnvironmentRpcError]),
});

export const WsServerDiscoverSourceControlRpc = Rpc.make(WS_METHODS.serverDiscoverSourceControl, {
  payload: Schema.Struct({}),
  success: SourceControlDiscoveryResult,
  error: EnvironmentRpcError,
});

export const WsServerGetTraceDiagnosticsRpc = Rpc.make(WS_METHODS.serverGetTraceDiagnostics, {
  payload: Schema.Struct({}),
  success: ServerTraceDiagnosticsResult,
  error: EnvironmentRpcError,
});

export const WsServerGetProcessDiagnosticsRpc = Rpc.make(WS_METHODS.serverGetProcessDiagnostics, {
  payload: Schema.Struct({}),
  success: ServerProcessDiagnosticsResult,
  error: EnvironmentRpcError,
});

export const WsServerGetProcessResourceHistoryRpc = Rpc.make(
  WS_METHODS.serverGetProcessResourceHistory,
  {
    payload: ServerProcessResourceHistoryInput,
    success: ServerProcessResourceHistoryResult,
    error: EnvironmentRpcError,
  },
);

export const WsServerSignalProcessRpc = Rpc.make(WS_METHODS.serverSignalProcess, {
  payload: ServerSignalProcessInput,
  success: ServerSignalProcessResult,
  error: EnvironmentRpcError,
});

export const WsServerGetProviderUsageRpc = Rpc.make(WS_METHODS.serverGetProviderUsage, {
  payload: Schema.Struct({}),
  success: ServerProviderUsageResult,
  error: EnvironmentRpcError,
});

export const WsServerRefreshProviderUsageRpc = Rpc.make(WS_METHODS.serverRefreshProviderUsage, {
  payload: ServerProviderUsageRefreshInput,
  success: ServerProviderUsageResult,
  error: EnvironmentRpcError,
});

export const WsServerConsumeCodexRateLimitResetRpc = Rpc.make(
  WS_METHODS.serverConsumeCodexRateLimitReset,
  {
    payload: ConsumeCodexRateLimitResetInput,
    success: ConsumeCodexRateLimitResetResult,
    error: Schema.Union([ServerProviderUsageResetError, EnvironmentRpcError]),
  },
);

export const WsUpdaterStatusRpc = Rpc.make(WS_METHODS.updaterStatus, {
  payload: Schema.Struct({}),
  success: RemoteUpdateSnapshot,
  error: EnvironmentRpcError,
});

export const WsUpdaterCheckRpc = Rpc.make(WS_METHODS.updaterCheck, {
  payload: Schema.Struct({}),
  success: RemoteUpdateSnapshot,
  error: EnvironmentRpcError,
});

export const WsUpdaterInstallRpc = Rpc.make(WS_METHODS.updaterInstall, {
  payload: Schema.Struct({}),
  success: RemoteUpdateSnapshot,
  error: Schema.Union([RemoteUpdateInstallError, EnvironmentRpcError]),
});

export const WsCloudGetRelayClientStatusRpc = Rpc.make(WS_METHODS.cloudGetRelayClientStatus, {
  payload: Schema.Struct({}),
  success: RelayClientStatusSchema,
  error: EnvironmentRpcError,
});

export const WsCloudInstallRelayClientRpc = Rpc.make(WS_METHODS.cloudInstallRelayClient, {
  payload: Schema.Struct({}),
  success: RelayClientInstallProgressEventSchema,
  error: Schema.Union([RelayClientInstallFailedError, EnvironmentRpcError]),
  stream: true,
});

export const WsSourceControlLookupRepositoryRpc = Rpc.make(
  WS_METHODS.sourceControlLookupRepository,
  {
    payload: SourceControlRepositoryLookupInput,
    success: SourceControlRepositoryInfo,
    error: Schema.Union([
      SourceControlRepositoryError,
      WorkspaceUnavailableError,
      WorkspaceIdentityError,
      EnvironmentRpcError,
    ]),
  },
);

export const WsSourceControlCloneRepositoryRpc = Rpc.make(WS_METHODS.sourceControlCloneRepository, {
  payload: SourceControlCloneRepositoryInput,
  success: SourceControlCloneRepositoryResult,
  error: Schema.Union([SourceControlRepositoryError, EnvironmentRpcError]),
});

export const WsSourceControlPublishRepositoryRpc = Rpc.make(
  WS_METHODS.sourceControlPublishRepository,
  {
    payload: SourceControlPublishRepositoryInput,
    success: SourceControlPublishRepositoryResult,
    error: Schema.Union([
      SourceControlRepositoryError,
      WorkspaceUnavailableError,
      WorkspaceIdentityError,
      EnvironmentRpcError,
    ]),
  },
);

export const WsProjectsSearchEntriesRpc = Rpc.make(WS_METHODS.projectsSearchEntries, {
  payload: ProjectSearchEntriesInput,
  success: ProjectSearchEntriesResult,
  error: Schema.Union([
    ProjectSearchEntriesError,
    WorkspaceUnavailableError,
    WorkspaceIdentityError,
    EnvironmentRpcError,
  ]),
});

export const WsProjectsListEntriesRpc = Rpc.make(WS_METHODS.projectsListEntries, {
  payload: ProjectListEntriesInput,
  success: ProjectListEntriesResult,
  error: Schema.Union([
    ProjectListEntriesError,
    WorkspaceUnavailableError,
    WorkspaceIdentityError,
    EnvironmentRpcError,
  ]),
});

export const WsProjectsSubscribeEntriesRpc = Rpc.make(WS_METHODS.projectsSubscribeEntries, {
  payload: ProjectSubscribeEntriesInput,
  success: ProjectEntriesChangedEvent,
  error: Schema.Union([
    ProjectListEntriesError,
    WorkspaceUnavailableError,
    WorkspaceIdentityError,
    EnvironmentRpcError,
  ]),
  stream: true,
});

export const WsProjectsReadFileRpc = Rpc.make(WS_METHODS.projectsReadFile, {
  payload: ProjectReadFileInput,
  success: ProjectReadFileResult,
  error: Schema.Union([
    ProjectReadFileError,
    WorkspaceUnavailableError,
    WorkspaceIdentityError,
    EnvironmentRpcError,
  ]),
});

export const WsProjectsWriteFileRpc = Rpc.make(WS_METHODS.projectsWriteFile, {
  payload: ProjectWriteFileInput,
  success: ProjectWriteFileResult,
  error: Schema.Union([
    ProjectWriteFileError,
    WorkspaceUnavailableError,
    WorkspaceIdentityError,
    EnvironmentRpcError,
  ]),
});

export const WsProjectsCreateEntryRpc = Rpc.make(WS_METHODS.projectsCreateEntry, {
  payload: ProjectCreateEntryInput,
  success: ProjectCreateEntryResult,
  error: Schema.Union([
    ProjectCreateEntryError,
    WorkspaceUnavailableError,
    WorkspaceIdentityError,
    EnvironmentRpcError,
  ]),
});

export const WsProjectsRenameEntryRpc = Rpc.make(WS_METHODS.projectsRenameEntry, {
  payload: ProjectRenameEntryInput,
  success: ProjectRenameEntryResult,
  error: Schema.Union([
    ProjectRenameEntryError,
    WorkspaceUnavailableError,
    WorkspaceIdentityError,
    EnvironmentRpcError,
  ]),
});

export const WsProjectsDeleteEntryRpc = Rpc.make(WS_METHODS.projectsDeleteEntry, {
  payload: ProjectDeleteEntryInput,
  success: ProjectDeleteEntryResult,
  error: Schema.Union([
    ProjectDeleteEntryError,
    WorkspaceUnavailableError,
    WorkspaceIdentityError,
    EnvironmentRpcError,
  ]),
});

export const WsProjectsDuplicateEntryRpc = Rpc.make(WS_METHODS.projectsDuplicateEntry, {
  payload: ProjectDuplicateEntryInput,
  success: ProjectDuplicateEntryResult,
  error: Schema.Union([
    ProjectDuplicateEntryError,
    WorkspaceUnavailableError,
    WorkspaceIdentityError,
    EnvironmentRpcError,
  ]),
});

export const WsShellOpenInEditorRpc = Rpc.make(WS_METHODS.shellOpenInEditor, {
  payload: LaunchEditorInput,
  error: Schema.Union([
    ExternalLauncherError,
    WorkspaceUnavailableError,
    WorkspaceIdentityError,
    EnvironmentRpcError,
  ]),
});

export const WsFilesystemBrowseRpc = Rpc.make(WS_METHODS.filesystemBrowse, {
  payload: FilesystemBrowseInput,
  success: FilesystemBrowseResult,
  error: Schema.Union([
    FilesystemBrowseError,
    WorkspaceUnavailableError,
    WorkspaceIdentityError,
    EnvironmentRpcError,
  ]),
});

export const WsAssetsCreateUrlRpc = Rpc.make(WS_METHODS.assetsCreateUrl, {
  payload: AssetCreateUrlInput,
  success: AssetCreateUrlResult,
  error: Schema.Union([
    AssetAccessError,
    WorkspaceUnavailableError,
    WorkspaceIdentityError,
    EnvironmentRpcError,
  ]),
});

export const WsSubscribeVcsStatusRpc = Rpc.make(WS_METHODS.subscribeVcsStatus, {
  payload: VcsStatusInput,
  success: VcsStatusStreamEvent,
  error: Schema.Union([
    GitManagerServiceError,
    WorkspaceUnavailableError,
    WorkspaceIdentityError,
    EnvironmentRpcError,
  ]),
  stream: true,
});

export const WsSubscribeVcsStatusSummaryRpc = Rpc.make(WS_METHODS.subscribeVcsStatusSummary, {
  payload: VcsStatusInput,
  success: VcsStatusSummary,
  error: Schema.Union([
    GitManagerServiceError,
    WorkspaceUnavailableError,
    WorkspaceIdentityError,
    EnvironmentRpcError,
  ]),
  stream: true,
});

export const WsVcsPullRpc = Rpc.make(WS_METHODS.vcsPull, {
  payload: VcsPullInput,
  success: VcsPullResult,
  error: Schema.Union([
    GitCommandError,
    WorkspaceUnavailableError,
    WorkspaceIdentityError,
    EnvironmentRpcError,
  ]),
});

export const WsVcsRefreshStatusRpc = Rpc.make(WS_METHODS.vcsRefreshStatus, {
  payload: VcsStatusInput,
  success: VcsStatusResult,
  error: Schema.Union([
    GitManagerServiceError,
    WorkspaceUnavailableError,
    WorkspaceIdentityError,
    EnvironmentRpcError,
  ]),
});

export const WsGitRunStackedActionRpc = Rpc.make(WS_METHODS.gitRunStackedAction, {
  payload: GitRunStackedActionInput,
  success: GitActionProgressEvent,
  error: Schema.Union([
    GitManagerServiceError,
    WorkspaceUnavailableError,
    WorkspaceIdentityError,
    EnvironmentRpcError,
  ]),
  stream: true,
});

export const WsGitResolvePullRequestRpc = Rpc.make(WS_METHODS.gitResolvePullRequest, {
  payload: GitPullRequestRefInput,
  success: GitResolvePullRequestResult,
  error: Schema.Union([
    GitManagerServiceError,
    WorkspaceUnavailableError,
    WorkspaceIdentityError,
    EnvironmentRpcError,
  ]),
});

export const WsGitPreparePullRequestThreadRpc = Rpc.make(WS_METHODS.gitPreparePullRequestThread, {
  payload: GitPreparePullRequestThreadInput,
  success: GitPreparePullRequestThreadResult,
  error: Schema.Union([
    GitManagerServiceError,
    WorkspaceUnavailableError,
    WorkspaceIdentityError,
    EnvironmentRpcError,
  ]),
});

export const WsVcsListRefsRpc = Rpc.make(WS_METHODS.vcsListRefs, {
  payload: VcsListRefsInput,
  success: VcsListRefsResult,
  error: Schema.Union([
    GitCommandError,
    WorkspaceUnavailableError,
    WorkspaceIdentityError,
    EnvironmentRpcError,
  ]),
});

export const WsVcsListCommitsRpc = Rpc.make(WS_METHODS.vcsListCommits, {
  payload: VcsListCommitsInput,
  success: VcsListCommitsResult,
  error: Schema.Union([
    GitCommandError,
    WorkspaceUnavailableError,
    WorkspaceIdentityError,
    EnvironmentRpcError,
  ]),
});

export const WsVcsCloneRpc = Rpc.make(WS_METHODS.vcsClone, {
  payload: GitCloneInput,
  success: GitCloneResult,
  error: Schema.Union([
    GitCommandError,
    WorkspaceUnavailableError,
    WorkspaceIdentityError,
    EnvironmentRpcError,
  ]),
});

export const WsVcsCreateRefRpc = Rpc.make(WS_METHODS.vcsCreateRef, {
  payload: VcsCreateRefInput,
  success: VcsCreateRefResult,
  error: Schema.Union([
    GitCommandError,
    WorkspaceUnavailableError,
    WorkspaceIdentityError,
    EnvironmentRpcError,
  ]),
});

export const WsVcsSwitchRefRpc = Rpc.make(WS_METHODS.vcsSwitchRef, {
  payload: VcsSwitchRefInput,
  success: VcsSwitchRefResult,
  error: Schema.Union([
    GitCommandError,
    WorkspaceUnavailableError,
    WorkspaceIdentityError,
    EnvironmentRpcError,
  ]),
});

export const WsVcsInitRpc = Rpc.make(WS_METHODS.vcsInit, {
  payload: VcsInitInput,
  error: Schema.Union([
    VcsError,
    WorkspaceUnavailableError,
    WorkspaceIdentityError,
    EnvironmentRpcError,
  ]),
});

export const WsVcsStageFilesRpc = Rpc.make(WS_METHODS.vcsStageFiles, {
  payload: VcsStageFilesInput,
  error: Schema.Union([
    GitCommandError,
    WorkspaceUnavailableError,
    WorkspaceIdentityError,
    EnvironmentRpcError,
  ]),
});

export const WsVcsUnstageFilesRpc = Rpc.make(WS_METHODS.vcsUnstageFiles, {
  payload: VcsUnstageFilesInput,
  error: Schema.Union([
    GitCommandError,
    WorkspaceUnavailableError,
    WorkspaceIdentityError,
    EnvironmentRpcError,
  ]),
});

export const WsVcsDiscardFilesRpc = Rpc.make(WS_METHODS.vcsDiscardFiles, {
  payload: VcsDiscardFilesInput,
  error: Schema.Union([
    GitCommandError,
    WorkspaceUnavailableError,
    WorkspaceIdentityError,
    EnvironmentRpcError,
  ]),
});

export const WsVcsGenerateCommitMessageRpc = Rpc.make(WS_METHODS.vcsGenerateCommitMessage, {
  payload: VcsGenerateCommitMessageInput,
  success: VcsGenerateCommitMessageResult,
  error: Schema.Union([
    GitManagerServiceError,
    WorkspaceUnavailableError,
    WorkspaceIdentityError,
    EnvironmentRpcError,
  ]),
});

export const WsSubscribeWorktreeCatalogRpc = Rpc.make(WS_METHODS.subscribeWorktreeCatalog, {
  payload: WorktreeCatalogInput,
  success: VcsWorktreeCatalogSnapshot,
  error: Schema.Union([WorktreeCatalogError, EnvironmentRpcError]),
  stream: true,
});

export const WsVcsRefreshWorktreeCatalogRpc = Rpc.make(WS_METHODS.vcsRefreshWorktreeCatalog, {
  payload: WorktreeCatalogRefreshInput,
  success: VcsWorktreeCatalogSnapshot,
  error: Schema.Union([WorktreeCatalogError, EnvironmentRpcError]),
});

export const WsWorktreeUpdateDiscoveryPolicyRpc = Rpc.make(
  WS_METHODS.worktreeUpdateDiscoveryPolicy,
  {
    payload: WorktreeDiscoveryPolicyUpdateInput,
    success: ProjectWorktreeDiscoveryPolicy,
    error: Schema.Union([WorktreeCatalogError, WorktreeOperationError, EnvironmentRpcError]),
  },
);

export const WsWorktreeAdoptRpc = Rpc.make(WS_METHODS.worktreeAdopt, {
  payload: WorktreeAdoptInput,
  success: WorktreeAdoptResult,
  error: Schema.Union([WorktreeAdoptionError, WorktreeOperationError, EnvironmentRpcError]),
});

export const WsWorktreeCreateManagedRpc = Rpc.make(WS_METHODS.worktreeCreateManaged, {
  payload: WorktreeCreateManagedInput,
  success: WorktreeManagedCreateResult,
  error: Schema.Union([
    WorktreeAdoptionError,
    WorktreeOperationError,
    GitCommandError,
    EnvironmentRpcError,
  ]),
});

export const WsWorktreeCreatePanelRpc = Rpc.make(WS_METHODS.worktreeCreatePanel, {
  payload: WorktreeCreatePanelInput,
  success: WorktreeThreadResult,
  error: Schema.Union([WorktreeAdoptionError, WorktreeOperationError, EnvironmentRpcError]),
});

export const WsWorktreeRetargetRpc = Rpc.make(WS_METHODS.worktreeRetarget, {
  payload: WorktreeRetargetInput,
  success: WorktreeThreadResult,
  error: Schema.Union([WorktreeAdoptionError, WorktreeOperationError, EnvironmentRpcError]),
});

export const WsWorktreeGetRemovalPlanRpc = Rpc.make(WS_METHODS.worktreeGetRemovalPlan, {
  payload: WorktreeGetRemovalPlanInput,
  success: WorktreeRemovalPlan,
  error: Schema.Union([WorktreeRemovalError, WorktreeOperationError, EnvironmentRpcError]),
});

export const WsWorktreeRemoveFromBibCodeRpc = Rpc.make(WS_METHODS.worktreeRemoveFromBibCode, {
  payload: WorktreeRemoveFromBibCodeInput,
  success: WorktreeRemovalResult,
  error: Schema.Union([
    WorktreeRemovalError,
    WorktreeOperationError,
    WorkspaceIdentityError,
    EnvironmentRpcError,
  ]),
});

export const WsWorktreeRemoveRpc = Rpc.make(WS_METHODS.worktreeRemove, {
  payload: WorktreeRemoveInput,
  success: WorktreeRemovalResult,
  error: Schema.Union([
    WorktreeRemovalError,
    WorktreeOperationError,
    WorkspaceIdentityError,
    EnvironmentRpcError,
  ]),
});

/**
 * Ephemeral live diff preview for compact/mobile surfaces.
 * Not the persisted BiBCode Review model. Future review sessions should use
 * review.open* + review.getSnapshot.
 */
export const WsReviewGetDiffPreviewRpc = Rpc.make(WS_METHODS.reviewGetDiffPreview, {
  payload: ReviewDiffPreviewInput,
  success: ReviewDiffPreviewResult,
  error: Schema.Union([
    ReviewDiffPreviewError,
    WorkspaceUnavailableError,
    WorkspaceIdentityError,
    EnvironmentRpcError,
  ]),
});

export const WsTerminalOpenRpc = Rpc.make(WS_METHODS.terminalOpen, {
  payload: TerminalOpenInput,
  success: TerminalSessionSnapshot,
  error: Schema.Union([
    TerminalError,
    WorkspaceUnavailableError,
    WorkspaceIdentityError,
    EnvironmentRpcError,
  ]),
});

export const WsTerminalAttachRpc = Rpc.make(WS_METHODS.terminalAttach, {
  payload: TerminalAttachInput,
  success: TerminalAttachStreamEvent,
  error: Schema.Union([
    TerminalError,
    WorkspaceUnavailableError,
    WorkspaceIdentityError,
    EnvironmentRpcError,
  ]),
  stream: true,
});

export const WsTerminalWriteRpc = Rpc.make(WS_METHODS.terminalWrite, {
  payload: TerminalWriteInput,
  error: Schema.Union([
    TerminalError,
    WorkspaceUnavailableError,
    WorkspaceIdentityError,
    EnvironmentRpcError,
  ]),
});

export const WsTerminalResizeRpc = Rpc.make(WS_METHODS.terminalResize, {
  payload: TerminalResizeInput,
  error: Schema.Union([TerminalError, EnvironmentRpcError]),
});

export const WsTerminalClearRpc = Rpc.make(WS_METHODS.terminalClear, {
  payload: TerminalClearInput,
  error: Schema.Union([TerminalError, EnvironmentRpcError]),
});

export const WsTerminalRestartRpc = Rpc.make(WS_METHODS.terminalRestart, {
  payload: TerminalRestartInput,
  success: TerminalSessionSnapshot,
  error: Schema.Union([
    TerminalError,
    WorkspaceUnavailableError,
    WorkspaceIdentityError,
    EnvironmentRpcError,
  ]),
});

export const WsTerminalCloseRpc = Rpc.make(WS_METHODS.terminalClose, {
  payload: TerminalCloseInput,
  error: Schema.Union([TerminalError, EnvironmentRpcError]),
});

export const WsPreviewOpenRpc = Rpc.make(WS_METHODS.previewOpen, {
  payload: PreviewOpenInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentRpcError]),
});

export const WsPreviewNavigateRpc = Rpc.make(WS_METHODS.previewNavigate, {
  payload: PreviewNavigateInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentRpcError]),
});

export const WsPreviewResizeRpc = Rpc.make(WS_METHODS.previewResize, {
  payload: PreviewResizeInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentRpcError]),
});

export const WsPreviewRefreshRpc = Rpc.make(WS_METHODS.previewRefresh, {
  payload: PreviewRefreshInput,
  error: Schema.Union([PreviewError, EnvironmentRpcError]),
});

export const WsPreviewCloseRpc = Rpc.make(WS_METHODS.previewClose, {
  payload: PreviewCloseInput,
  error: Schema.Union([PreviewError, EnvironmentRpcError]),
});

export const WsPreviewListRpc = Rpc.make(WS_METHODS.previewList, {
  payload: PreviewListInput,
  success: PreviewListResult,
  error: EnvironmentRpcError,
});

export const WsPreviewReportStatusRpc = Rpc.make(WS_METHODS.previewReportStatus, {
  payload: PreviewReportStatusInput,
  error: Schema.Union([PreviewError, EnvironmentRpcError]),
});

export const WsPreviewAutomationConnectRpc = Rpc.make(WS_METHODS.previewAutomationConnect, {
  payload: PreviewAutomationHost,
  success: PreviewAutomationStreamEvent,
  error: Schema.Union([PreviewAutomationError, EnvironmentRpcError]),
  stream: true,
});

export const WsPreviewAutomationRespondRpc = Rpc.make(WS_METHODS.previewAutomationRespond, {
  payload: PreviewAutomationResponse,
  error: Schema.Union([PreviewAutomationError, EnvironmentRpcError]),
});

export const WsPreviewAutomationFocusHostRpc = Rpc.make(WS_METHODS.previewAutomationFocusHost, {
  payload: PreviewAutomationHostFocus,
  error: EnvironmentRpcError,
});

export const WsSubscribePreviewEventsRpc = Rpc.make(WS_METHODS.subscribePreviewEvents, {
  payload: Schema.Struct({}),
  success: PreviewEvent,
  error: EnvironmentRpcError,
  stream: true,
});

export const WsSubscribeDiscoveredLocalServersRpc = Rpc.make(
  WS_METHODS.subscribeDiscoveredLocalServers,
  {
    payload: Schema.Struct({}),
    success: DiscoveredLocalServerList,
    error: EnvironmentRpcError,
    stream: true,
  },
);

export const WsOrchestrationDispatchCommandRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.dispatchCommand,
  {
    payload: ClientOrchestrationCommand,
    success: OrchestrationRpcSchemas.dispatchCommand.output,
    error: Schema.Union([
      OrchestrationDispatchCommandError,
      WorkspaceUnavailableError,
      WorkspaceIdentityError,
      EnvironmentRpcError,
    ]),
  },
);

export const WsOrchestrationGetTurnDiffRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getTurnDiff, {
  payload: OrchestrationGetTurnDiffInput,
  success: OrchestrationRpcSchemas.getTurnDiff.output,
  error: Schema.Union([OrchestrationGetTurnDiffError, EnvironmentRpcError]),
});

export const WsOrchestrationGetFullThreadDiffRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getFullThreadDiff,
  {
    payload: OrchestrationGetFullThreadDiffInput,
    success: OrchestrationRpcSchemas.getFullThreadDiff.output,
    error: Schema.Union([OrchestrationGetFullThreadDiffError, EnvironmentRpcError]),
  },
);

export const WsOrchestrationReplayEventsRpc = Rpc.make(ORCHESTRATION_WS_METHODS.replayEvents, {
  payload: OrchestrationReplayEventsInput,
  success: OrchestrationRpcSchemas.replayEvents.output,
  error: Schema.Union([OrchestrationReplayEventsError, EnvironmentRpcError]),
});

export const WsOrchestrationGetArchivedShellSnapshotRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
  {
    payload: OrchestrationRpcSchemas.getArchivedShellSnapshot.input,
    success: OrchestrationRpcSchemas.getArchivedShellSnapshot.output,
    error: Schema.Union([OrchestrationGetSnapshotError, EnvironmentRpcError]),
  },
);

export const WsOrchestrationSubscribeShellRpc = Rpc.make(ORCHESTRATION_WS_METHODS.subscribeShell, {
  payload: OrchestrationRpcSchemas.subscribeShell.input,
  success: OrchestrationRpcSchemas.subscribeShell.output,
  error: Schema.Union([OrchestrationGetSnapshotError, EnvironmentRpcError]),
  stream: true,
});

export const WsOrchestrationSubscribeThreadRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.subscribeThread,
  {
    payload: OrchestrationRpcSchemas.subscribeThread.input,
    success: OrchestrationRpcSchemas.subscribeThread.output,
    error: Schema.Union([OrchestrationGetSnapshotError, EnvironmentRpcError]),
    stream: true,
  },
);

export const WsSubscribeTerminalEventsRpc = Rpc.make(WS_METHODS.subscribeTerminalEvents, {
  payload: Schema.Struct({}),
  success: TerminalEvent,
  error: EnvironmentRpcError,
  stream: true,
});

export const WsSubscribeTerminalMetadataRpc = Rpc.make(WS_METHODS.subscribeTerminalMetadata, {
  payload: Schema.Struct({}),
  success: TerminalMetadataStreamEvent,
  error: EnvironmentRpcError,
  stream: true,
});

export const WsSubscribeServerConfigRpc = Rpc.make(WS_METHODS.subscribeServerConfig, {
  payload: Schema.Struct({}),
  success: ServerConfigStreamEvent,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError, EnvironmentRpcError]),
  stream: true,
});

export const WsSubscribeServerLifecycleRpc = Rpc.make(WS_METHODS.subscribeServerLifecycle, {
  payload: Schema.Struct({}),
  success: ServerLifecycleStreamEvent,
  error: EnvironmentRpcError,
  stream: true,
});

export const WsSubscribeAuthAccessRpc = Rpc.make(WS_METHODS.subscribeAuthAccess, {
  payload: Schema.Struct({}),
  success: AuthAccessStreamEvent,
  error: Schema.Union([AuthAccessStreamError, EnvironmentRpcError]),
  stream: true,
});

export const WsActivityGetSnapshotRpc = Rpc.make(WS_METHODS.activityGetSnapshot, {
  payload: ActivityGetSnapshotInput,
  success: ActivitySnapshot,
  error: Schema.Union([ActivityError, EnvironmentRpcError]),
});

export const WsActivityListRosterRpc = Rpc.make(WS_METHODS.activityListRoster, {
  payload: ActivityListRosterInput,
  success: ActivityRosterPage,
  error: Schema.Union([ActivityError, EnvironmentRpcError]),
});

export const WsActivityListDetailRpc = Rpc.make(WS_METHODS.activityListDetail, {
  payload: ActivityListDetailInput,
  success: ActivityDetailPage,
  error: Schema.Union([ActivityError, EnvironmentRpcError]),
});

export const WsActivityCancelSubtreeRpc = Rpc.make(WS_METHODS.activityCancelSubtree, {
  payload: ActivityCancelSubtreeInput,
  success: ActivitySubtreeCancellationResult,
  error: Schema.Union([ActivityError, EnvironmentRpcError]),
});

export const WsActivityRetrySubtreeCancellationRpc = Rpc.make(
  WS_METHODS.activityRetrySubtreeCancellation,
  {
    payload: ActivityRetrySubtreeCancellationInput,
    success: ActivitySubtreeCancellationResult,
    error: Schema.Union([ActivityError, EnvironmentRpcError]),
  },
);

export const WsSubscribeActivityRpc = Rpc.make(WS_METHODS.subscribeActivity, {
  payload: ActivityScopeRef,
  success: ActivityStreamItem,
  error: Schema.Union([ActivityError, EnvironmentRpcError]),
  stream: true,
});

export const WsRpcGroup = RpcGroup.make(
  WsServerGetConfigRpc,
  WsServerRefreshProvidersRpc,
  WsServerUpdateProviderRpc,
  WsServerUpsertKeybindingRpc,
  WsServerRemoveKeybindingRpc,
  WsServerGetSettingsRpc,
  WsServerUpdateSettingsRpc,
  WsServerDiscoverSourceControlRpc,
  WsServerGetTraceDiagnosticsRpc,
  WsServerGetProcessDiagnosticsRpc,
  WsServerGetProcessResourceHistoryRpc,
  WsServerSignalProcessRpc,
  WsServerGetProviderUsageRpc,
  WsServerRefreshProviderUsageRpc,
  WsServerConsumeCodexRateLimitResetRpc,
  WsUpdaterStatusRpc,
  WsUpdaterCheckRpc,
  WsUpdaterInstallRpc,
  WsCloudGetRelayClientStatusRpc,
  WsCloudInstallRelayClientRpc,
  WsSourceControlLookupRepositoryRpc,
  WsSourceControlCloneRepositoryRpc,
  WsSourceControlPublishRepositoryRpc,
  WsProjectsListEntriesRpc,
  WsProjectsSubscribeEntriesRpc,
  WsProjectsReadFileRpc,
  WsProjectsSearchEntriesRpc,
  WsProjectsWriteFileRpc,
  WsProjectsCreateEntryRpc,
  WsProjectsRenameEntryRpc,
  WsProjectsDeleteEntryRpc,
  WsProjectsDuplicateEntryRpc,
  WsShellOpenInEditorRpc,
  WsFilesystemBrowseRpc,
  WsAssetsCreateUrlRpc,
  WsSubscribeVcsStatusRpc,
  WsSubscribeVcsStatusSummaryRpc,
  WsVcsPullRpc,
  WsVcsRefreshStatusRpc,
  WsGitRunStackedActionRpc,
  WsGitResolvePullRequestRpc,
  WsGitPreparePullRequestThreadRpc,
  WsVcsListRefsRpc,
  WsVcsListCommitsRpc,
  WsVcsCloneRpc,
  WsVcsCreateRefRpc,
  WsVcsSwitchRefRpc,
  WsVcsInitRpc,
  WsVcsStageFilesRpc,
  WsVcsUnstageFilesRpc,
  WsVcsDiscardFilesRpc,
  WsVcsGenerateCommitMessageRpc,
  WsSubscribeWorktreeCatalogRpc,
  WsVcsRefreshWorktreeCatalogRpc,
  WsWorktreeUpdateDiscoveryPolicyRpc,
  WsWorktreeAdoptRpc,
  WsWorktreeCreateManagedRpc,
  WsWorktreeCreatePanelRpc,
  WsWorktreeRetargetRpc,
  WsWorktreeGetRemovalPlanRpc,
  WsWorktreeRemoveFromBibCodeRpc,
  WsWorktreeRemoveRpc,
  WsReviewGetDiffPreviewRpc,
  WsTerminalOpenRpc,
  WsTerminalAttachRpc,
  WsTerminalWriteRpc,
  WsTerminalResizeRpc,
  WsTerminalClearRpc,
  WsTerminalRestartRpc,
  WsTerminalCloseRpc,
  WsSubscribeTerminalEventsRpc,
  WsSubscribeTerminalMetadataRpc,
  WsPreviewOpenRpc,
  WsPreviewNavigateRpc,
  WsPreviewResizeRpc,
  WsPreviewRefreshRpc,
  WsPreviewCloseRpc,
  WsPreviewListRpc,
  WsPreviewReportStatusRpc,
  WsPreviewAutomationConnectRpc,
  WsPreviewAutomationRespondRpc,
  WsPreviewAutomationFocusHostRpc,
  WsSubscribePreviewEventsRpc,
  WsSubscribeDiscoveredLocalServersRpc,
  WsSubscribeServerConfigRpc,
  WsSubscribeServerLifecycleRpc,
  WsSubscribeAuthAccessRpc,
  WsActivityGetSnapshotRpc,
  WsActivityListRosterRpc,
  WsActivityListDetailRpc,
  WsActivityCancelSubtreeRpc,
  WsActivityRetrySubtreeCancellationRpc,
  WsSubscribeActivityRpc,
  WsOrchestrationDispatchCommandRpc,
  WsOrchestrationGetTurnDiffRpc,
  WsOrchestrationGetFullThreadDiffRpc,
  WsOrchestrationReplayEventsRpc,
  WsOrchestrationGetArchivedShellSnapshotRpc,
  WsOrchestrationSubscribeShellRpc,
  WsOrchestrationSubscribeThreadRpc,
);
