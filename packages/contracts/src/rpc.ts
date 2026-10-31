import {
  UploadBeginInput,
  UploadBeginResult,
  UploadAppendInput,
  UploadAppendResult,
  UploadGetInput,
  UploadGetResult,
  UploadCancelInput,
  UploadCancelResult,
  UploadError,
  TerminalStageImagePasteInput,
  TerminalStageImagePasteResult,
} from "./uploads.ts";
import * as Schema from "effect/Schema";
import {
  DeviceCatalog,
  DeviceIdInput,
  DeviceInputInput,
  DeviceJpegFrame,
  DeviceMediaTicket,
  DeviceOpenInput,
  DeviceOpenResult,
  DeviceRotateInput,
  DeviceRotateResult,
  DeviceRpcError,
} from "./device.ts";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import {
  PullRequestsActionRequest,
  PullRequestsActionResult,
  PullRequestsCheckoutInput,
  PullRequestsCheckoutResult,
  PullRequestsChecks,
  PullRequestsCommits,
  PullRequestsContext,
  PullRequestsDetail,
  PullRequestsFiles,
  PullRequestsGetContextInput,
  PullRequestsListInput,
  PullRequestsListPage,
  PullRequestsNumberInput,
  PullRequestsOperationError,
  PullRequestsTimeline,
  PullRequestsVocabulary,
  PullRequestsVocabularyInput,
  PullRequestsCwdInput,
  PullRequestsCreateDefaults,
  PullRequestsChanged,
  PullRequestsSnapshot,
  PullRequestsSubscribeInput,
} from "./pullRequests.ts";
import {
  PipelinesActionResult,
  PipelinesChanged,
  PipelinesDetail,
  PipelinesGetInput,
  PipelinesJobDetail,
  PipelinesJobInput,
  PipelinesJobLog,
  PipelinesJobLogInput,
  PipelinesListInput,
  PipelinesListPage,
  PipelinesRunActionInput,
  PipelinesSnapshot,
  PipelinesSubscribeInput,
} from "./pipelines.ts";

import { ExternalLauncherError, LaunchEditorInput } from "./editor.ts";
import {
  AgentSessionImportInput,
  AgentSessionImportResult,
  AgentSessionOpenInPanelInput,
  AgentSessionOpenInPanelResult,
  AgentSessionScanInput,
  AgentSessionScanResult,
  AgentSessionThreadListInput,
  AgentSessionThreadListResult,
  AgentSessionsError,
} from "./agentSessions.ts";
import {
  AuthAccessStreamError,
  AuthAccessStreamEvent,
  EnvironmentAuthorizationError,
  EnvironmentRpcError,
} from "./auth.ts";
import { McpActivityError, McpActivityStreamEvent } from "./mcpActivity.ts";
import {
  UiIntentError,
  UiIntentStreamEvent,
  UiPublishIntentInput,
  UiPublishIntentResult,
} from "./uiIntents.ts";
import {
  WebhookError,
  WebhooksDeleteResult,
  WebhooksEndpointInput,
  WebhooksListDeliveriesInput,
  WebhooksListDeliveriesResult,
  WebhooksListInput,
  WebhooksListResult,
  WebhooksRedeliverInput,
  WebhooksRotateSecretResult,
  WebhooksSendResult,
  WebhooksUpsertInput,
  WebhooksUpsertResult,
} from "./webhooks.ts";
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
  ProjectCreateDownloadUrlInput,
  ProjectCreateDownloadUrlResult,
  ProjectCreateUploadUrlInput,
  ProjectCreateUploadUrlResult,
  ProjectTransferError,
} from "./transfer.ts";
import {
  GitActionProgressEvent,
  VcsSwitchRefInput,
  VcsSwitchRefResult,
  GitCommandError,
  VcsCreateRefInput,
  VcsCreateRefResult,
  GitCancelCloneInput,
  GitCancelCloneResult,
  GitCloneInput,
  GitCloneOperationError,
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
  GitManagerCommitInput,
  GitManagerCommitPage,
  GitManagerCommitResult,
  GitManagerCwdInput,
  GitManagerDiff,
  GitManagerDiscardInput,
  GitManagerDiscardResult,
  GitManagerGetCommitsInput,
  GitManagerGetDiffInput,
  GitManagerMergePreview,
  GitManagerOperationError,
  GitManagerOperationEvent,
  GitManagerOperationRequest,
  GitManagerPartialSelectionInput,
  GitManagerPartialSelectionResult,
  GitManagerPreviewMergeInput,
  GitManagerPullRequestsResult,
  GitManagerRefsSnapshot,
  GitManagerRemoteTags,
  GitManagerRemoteTagsInput,
  GitManagerSignalEvent,
  GitManagerStashEntry,
  GitManagerUndoCommitResult,
} from "./gitManager.ts";
import {
  ReviewDiffPreviewError,
  ReviewDiffPreviewInput,
  ReviewDiffPreviewResult,
  ReviewDiffToolError,
  ReviewListDiffToolsInput,
  ReviewListDiffToolsResult,
  ReviewOpenDiffToolInput,
  ReviewOpenDiffToolResult,
  ReviewReadFileVersionInput,
  ReviewReadFileVersionResult,
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
  THREAD_PURPOSE_MAX_LENGTH,
} from "./orchestration.ts";
import {
  CommandId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  RemoteUpdateActiveWork,
  RemoteUpdateActiveWorkError,
  RemoteUpdateInstallError,
  RemoteUpdateSnapshot,
} from "./remoteUpdate.ts";
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
  ProjectFileVersion,
  ProjectGetFileVersionInput,
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
  ProjectWriteFileIfUnchangedInput,
  ProjectWriteFileIfUnchangedResult,
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
  TerminalBeginInput,
  TerminalCancelInput,
  TerminalInputAcknowledgement,
  TerminalInputError,
  TerminalInputLease,
  TerminalWriteInputFrame,
} from "./terminal.ts";
import {
  DiscoveredLocalServerList,
  PreviewClaimOpenRequestInput,
  PreviewClaimOpenRequestResult,
  PreviewCloseInput,
  PreviewError,
  PreviewGatewayError,
  PreviewGatewayOpenInput,
  PreviewGatewayOpenResult,
  PreviewTunnelCloseInput,
  PreviewTunnelError,
  PreviewTunnelEvent,
  PreviewTunnelOpenInput,
  PreviewTunnelWriteInput,
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
  DiagnosticLogsDownloadEvent,
  DiagnosticLogsDownloadInput,
  DiagnosticLogsError,
  DiagnosticLogsRelayClaimInput,
  DiagnosticLogsRelayClaimResult,
  DiagnosticLogsRelayError,
  DiagnosticLogsRelayEvent,
  DiagnosticLogsRelaySendInput,
  ServerConfigStreamEvent,
  ServerConfig,
  ServerProviderCapabilities,
  ServerProviderCapabilitiesInput,
  ServerProviderCapabilitiesError,
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
  SourceControlDiscoveryInput,
  SourceControlDiscoveryResult,
  SourceControlPublishRepositoryInput,
  SourceControlPublishRepositoryResult,
  SourceControlRepositoryError,
  SourceControlRepositoryInfo,
  SourceControlRepositoryLookupInput,
} from "./sourceControl.ts";
import {
  ProfilerClientBatch,
  ProfilerClientBatchInvalid,
  ProfilerClientBatchResult,
  ProfilerClientBatchTooLarge,
  ProfilerStatus,
} from "./profiler.ts";
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
  /** Why an outside agent creates it (#139, slice X1); shown with the agent's label. */
  purpose: Schema.optional(
    Schema.NullOr(Schema.String.check(Schema.isMaxLength(THREAD_PURPOSE_MAX_LENGTH))),
  ),
});
export type WorktreeCreateManagedInput = typeof WorktreeCreateManagedInput.Type;

export const WorktreeCreatePanelInput = Schema.Struct({
  commandId: CommandId,
  hostThreadId: ThreadId,
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  threadDefaults: WorktreeThreadDefaults,
  /** Why an outside agent opens it (#139, slices X1 and X4). */
  purpose: Schema.optional(
    Schema.NullOr(Schema.String.check(Schema.isMaxLength(THREAD_PURPOSE_MAX_LENGTH))),
  ),
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
  uploadsBegin: "uploads.begin",
  uploadsAppend: "uploads.append",
  uploadsGet: "uploads.get",
  uploadsCancel: "uploads.cancel",
  // Authentication methods
  authConfirmPairing: "auth.confirmPairing",

  // Project registry methods
  projectsList: "projects.list",
  projectsAdd: "projects.add",
  projectsRemove: "projects.remove",
  projectsListEntries: "projects.listEntries",
  projectsSubscribeEntries: "subscribeProjectEntries",
  projectsReadFile: "projects.readFile",
  projectsGetFileVersion: "projects.getFileVersion",
  projectsSearchEntries: "projects.searchEntries",
  projectsWriteFile: "projects.writeFile",
  projectsWriteFileIfUnchanged: "projects.writeFileIfUnchanged",
  projectsCreateEntry: "projects.createEntry",
  projectsRenameEntry: "projects.renameEntry",
  projectsDeleteEntry: "projects.deleteEntry",
  projectsDuplicateEntry: "projects.duplicateEntry",

  // CLI session import methods
  agentSessionsScan: "agentSessions.scan",
  agentSessionsImport: "agentSessions.import",
  agentSessionsListForThread: "agentSessions.listForThread",
  agentSessionsOpenInPanel: "agentSessions.openInPanel",

  // Shell methods
  shellOpenInEditor: "shell.openInEditor",

  // Filesystem methods
  filesystemBrowse: "filesystem.browse",
  assetsCreateUrl: "assets.createUrl",
  projectsCreateDownloadUrl: "projects.createDownloadUrl",
  projectsCreateUploadUrl: "projects.createUploadUrl",

  // VCS methods
  vcsPull: "vcs.pull",
  vcsRefreshStatus: "vcs.refreshStatus",
  vcsListRefs: "vcs.listRefs",
  vcsListCommits: "vcs.listCommits",
  vcsClone: "vcs.clone",
  vcsCancelClone: "vcs.cancelClone",
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

  // Git Manager methods
  gitManagerGetRefs: "gitManager.getRefs",
  gitManagerGetCommits: "gitManager.getCommits",
  gitManagerGetDiff: "gitManager.getDiff",
  gitManagerGetStashes: "gitManager.getStashes",
  gitManagerGetRemoteTags: "gitManager.getRemoteTags",
  gitManagerPreviewMerge: "gitManager.previewMerge",
  gitManagerListPullRequests: "gitManager.listPullRequests",
  gitManagerCommit: "gitManager.commit",
  gitManagerUndoCommit: "gitManager.undoCommit",
  gitManagerDiscard: "gitManager.discard",
  gitManagerStagePartial: "gitManager.stagePartial",
  gitManagerUnstagePartial: "gitManager.unstagePartial",
  gitManagerDiscardPartial: "gitManager.discardPartial",
  gitManagerRunOperation: "gitManager.runOperation",

  // Pull Requests methods
  pullRequestsGetContext: "pullRequests.getContext",
  pullRequestsGetVocabulary: "pullRequests.getVocabulary",
  pullRequestsGetCreateDefaults: "pullRequests.getCreateDefaults",
  pullRequestsList: "pullRequests.list",
  pullRequestsGet: "pullRequests.get",
  pullRequestsGetTimeline: "pullRequests.getTimeline",
  pullRequestsGetCommits: "pullRequests.getCommits",
  pullRequestsGetChecks: "pullRequests.getChecks",
  pullRequestsGetFiles: "pullRequests.getFiles",
  pullRequestsRunAction: "pullRequests.runAction",
  pullRequestsCheckout: "pullRequests.checkout",
  pullRequestsReadSnapshot: "pullRequests.readSnapshot",
  pullRequestsSubscribe: "pullRequests.subscribe",

  // Pipelines methods
  pipelinesList: "pipelines.list",
  pipelinesGet: "pipelines.get",
  pipelinesGetJob: "pipelines.getJob",
  pipelinesGetJobLog: "pipelines.getJobLog",
  pipelinesReadSnapshot: "pipelines.readSnapshot",
  pipelinesSubscribe: "pipelines.subscribe",
  pipelinesRunAction: "pipelines.runAction",

  // Git workflow methods
  gitRunStackedAction: "git.runStackedAction",
  gitResolvePullRequest: "git.resolvePullRequest",
  gitPreparePullRequestThread: "git.preparePullRequestThread",

  // Review methods
  reviewGetDiffPreview: "review.getDiffPreview",
  reviewReadFileVersion: "review.readFileVersion",
  reviewListDiffTools: "review.listDiffTools",
  reviewOpenDiffTool: "review.openDiffTool",

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
  terminalBeginInput: "terminal.beginInput",
  terminalWriteInput: "terminal.writeInput",
  terminalCancelInput: "terminal.cancelInput",
  terminalResize: "terminal.resize",
  terminalClear: "terminal.clear",
  terminalRestart: "terminal.restart",
  terminalClose: "terminal.close",
  terminalStageImagePaste: "terminal.stageImagePaste",

  // Preview methods
  previewOpen: "preview.open",
  previewNavigate: "preview.navigate",
  previewResize: "preview.resize",
  previewRefresh: "preview.refresh",
  previewClose: "preview.close",
  previewList: "preview.list",
  previewReportStatus: "preview.reportStatus",
  previewClaimOpenRequest: "preview.claimOpenRequest",
  previewGatewayOpen: "preview.gatewayOpen",
  previewTunnelOpen: "preview.tunnelOpen",
  previewTunnelWrite: "preview.tunnelWrite",
  previewTunnelClose: "preview.tunnelClose",
  previewAutomationConnect: "previewAutomation.connect",
  previewAutomationRespond: "previewAutomation.respond",
  previewAutomationFocusHost: "previewAutomation.focusHost",

  // Device preview methods
  deviceSubscribeCatalog: "device.subscribeCatalog",
  deviceRefreshCatalog: "device.refreshCatalog",
  deviceOpen: "device.open",
  deviceClose: "device.close",
  deviceInput: "device.input",
  deviceRotate: "device.rotate",
  deviceSubscribeFrames: "device.subscribeFrames",
  deviceCreateMediaTicket: "device.createMediaTicket",

  // Server meta
  serverGetConfig: "server.getConfig",
  serverGetProviderCapabilities: "server.getProviderCapabilities",
  serverRefreshProviders: "server.refreshProviders",
  serverUpdateProvider: "server.updateProvider",
  serverUpsertKeybinding: "server.upsertKeybinding",
  serverRemoveKeybinding: "server.removeKeybinding",
  serverGetSettings: "server.getSettings",
  serverUpdateSettings: "server.updateSettings",
  serverDiscoverSourceControl: "server.discoverSourceControl",
  serverGetTraceDiagnostics: "server.getTraceDiagnostics",
  serverDownloadDiagnosticLogs: "server.downloadDiagnosticLogs",
  serverSubscribeDiagnosticLogsRelay: "server.subscribeDiagnosticLogsRelay",
  serverClaimDiagnosticLogsRelay: "server.claimDiagnosticLogsRelay",
  serverSendDiagnosticLogsRelayItem: "server.sendDiagnosticLogsRelayItem",
  serverGetProcessDiagnostics: "server.getProcessDiagnostics",
  serverGetProcessResourceHistory: "server.getProcessResourceHistory",
  serverGetProfilerStatus: "server.getProfilerStatus",
  serverReportProfilerClientBatch: "server.reportProfilerClientBatch",
  serverSignalProcess: "server.signalProcess",
  serverGetProviderUsage: "server.getProviderUsage",
  serverRefreshProviderUsage: "server.refreshProviderUsage",
  serverConsumeCodexRateLimitReset: "server.consumeCodexRateLimitReset",

  // An outside agent's UI suggestions (#139, slice X4)
  uiPublishIntent: "ui.publishIntent",

  // Outbound webhooks (#139, slice X8)
  webhooksList: "webhooks.list",
  webhooksListDeliveries: "webhooks.listDeliveries",
  webhooksUpsert: "webhooks.upsert",
  webhooksDelete: "webhooks.delete",
  webhooksRotateSecret: "webhooks.rotateSecret",
  webhooksSendTest: "webhooks.sendTest",
  webhooksRedeliver: "webhooks.redeliver",

  // Remote updater methods
  updaterActiveWork: "updater.activeWork",
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
  subscribeMcpActivity: "subscribeMcpActivity",
  subscribeUiIntents: "subscribeUiIntents",
  subscribeActivity: "subscribeActivity",
  subscribeWorktreeCatalog: "subscribeWorktreeCatalog",
  subscribeGitManagerSignal: "subscribeGitManagerSignal",
} as const;

const AuthConfirmPairingEmpty = Schema.Record(Schema.String, Schema.Never);

export const WsAuthConfirmPairingRpc = Rpc.make(WS_METHODS.authConfirmPairing, {
  payload: AuthConfirmPairingEmpty,
  success: AuthConfirmPairingEmpty,
  error: EnvironmentAuthorizationError,
});

export const WsAgentSessionsScanRpc = Rpc.make(WS_METHODS.agentSessionsScan, {
  payload: AgentSessionScanInput,
  success: AgentSessionScanResult,
  error: Schema.Union([AgentSessionsError, EnvironmentRpcError]),
});

export const WsAgentSessionsImportRpc = Rpc.make(WS_METHODS.agentSessionsImport, {
  payload: AgentSessionImportInput,
  success: AgentSessionImportResult,
  error: Schema.Union([AgentSessionsError, EnvironmentRpcError]),
});

/** Only on servers that advertise `cliSessionHistory`. */
export const WsAgentSessionsListForThreadRpc = Rpc.make(WS_METHODS.agentSessionsListForThread, {
  payload: AgentSessionThreadListInput,
  success: AgentSessionThreadListResult,
  error: Schema.Union([AgentSessionsError, EnvironmentRpcError]),
});

/** Only on servers that advertise `cliSessionHistory`. */
export const WsAgentSessionsOpenInPanelRpc = Rpc.make(WS_METHODS.agentSessionsOpenInPanel, {
  payload: AgentSessionOpenInPanelInput,
  success: AgentSessionOpenInPanelResult,
  error: Schema.Union([AgentSessionsError, EnvironmentRpcError]),
});

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

export const WsServerGetProviderCapabilitiesRpc = Rpc.make(
  WS_METHODS.serverGetProviderCapabilities,
  {
    payload: ServerProviderCapabilitiesInput,
    success: ServerProviderCapabilities,
    error: Schema.Union([ServerProviderCapabilitiesError, EnvironmentRpcError]),
  },
);

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
  payload: SourceControlDiscoveryInput,
  success: SourceControlDiscoveryResult,
  error: EnvironmentRpcError,
});

export const WsServerGetTraceDiagnosticsRpc = Rpc.make(WS_METHODS.serverGetTraceDiagnostics, {
  payload: Schema.Struct({}),
  success: ServerTraceDiagnosticsResult,
  error: EnvironmentRpcError,
});

/**
 * The server's redacted diagnostic bundle over this connection (#194). Advertised by the
 * descriptor's `capabilities.diagnosticLogs`; never sent to a server without it.
 */
export const WsServerDownloadDiagnosticLogsRpc = Rpc.make(WS_METHODS.serverDownloadDiagnosticLogs, {
  payload: DiagnosticLogsDownloadInput,
  success: DiagnosticLogsDownloadEvent,
  error: Schema.Union([DiagnosticLogsError, EnvironmentRpcError]),
  stream: true,
});

/**
 * Requests from `bibcode diagnostics download` on this host, for the desktop app's own
 * session only (#201): every other session is refused with `not-desktop`.
 */
export const WsServerSubscribeDiagnosticLogsRelayRpc = Rpc.make(
  WS_METHODS.serverSubscribeDiagnosticLogsRelay,
  {
    payload: Schema.Struct({}),
    success: DiagnosticLogsRelayEvent,
    error: Schema.Union([DiagnosticLogsRelayError, EnvironmentRpcError]),
    stream: true,
  },
);

/** Takes a pending request for this connection; only its items are accepted afterwards. */
export const WsServerClaimDiagnosticLogsRelayRpc = Rpc.make(
  WS_METHODS.serverClaimDiagnosticLogsRelay,
  {
    payload: DiagnosticLogsRelayClaimInput,
    success: DiagnosticLogsRelayClaimResult,
    error: Schema.Union([DiagnosticLogsRelayError, EnvironmentRpcError]),
  },
);

/** One item for the claimed request; it answers once the command took the item before. */
export const WsServerSendDiagnosticLogsRelayItemRpc = Rpc.make(
  WS_METHODS.serverSendDiagnosticLogsRelayItem,
  {
    payload: DiagnosticLogsRelaySendInput,
    success: Schema.Struct({}),
    error: Schema.Union([DiagnosticLogsRelayError, EnvironmentRpcError]),
  },
);

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

export const WsServerGetProfilerStatusRpc = Rpc.make(WS_METHODS.serverGetProfilerStatus, {
  payload: Schema.Struct({}),
  success: ProfilerStatus,
  error: EnvironmentRpcError,
});

export const WsServerReportProfilerClientBatchRpc = Rpc.make(
  WS_METHODS.serverReportProfilerClientBatch,
  {
    payload: ProfilerClientBatch,
    success: ProfilerClientBatchResult,
    error: Schema.Union([
      ProfilerClientBatchTooLarge,
      ProfilerClientBatchInvalid,
      EnvironmentRpcError,
    ]),
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

export const WsUpdaterActiveWorkRpc = Rpc.make(WS_METHODS.updaterActiveWork, {
  payload: Schema.Struct({}),
  success: RemoteUpdateActiveWork,
  error: Schema.Union([RemoteUpdateActiveWorkError, EnvironmentRpcError]),
});

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

export const WsProjectsGetFileVersionRpc = Rpc.make(WS_METHODS.projectsGetFileVersion, {
  payload: ProjectGetFileVersionInput,
  success: ProjectFileVersion,
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

/**
 * Writes only when the file on disk is still the state the contents were based on; otherwise it
 * fails with `file_changed_on_disk` or `file_missing_on_disk` and leaves the file untouched.
 */
export const WsProjectsWriteFileIfUnchangedRpc = Rpc.make(WS_METHODS.projectsWriteFileIfUnchanged, {
  payload: ProjectWriteFileIfUnchangedInput,
  success: ProjectWriteFileIfUnchangedResult,
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

export const WsProjectsCreateDownloadUrlRpc = Rpc.make(WS_METHODS.projectsCreateDownloadUrl, {
  payload: ProjectCreateDownloadUrlInput,
  success: ProjectCreateDownloadUrlResult,
  error: Schema.Union([
    ProjectTransferError,
    WorkspaceUnavailableError,
    WorkspaceIdentityError,
    EnvironmentRpcError,
  ]),
});

export const WsProjectsCreateUploadUrlRpc = Rpc.make(WS_METHODS.projectsCreateUploadUrl, {
  payload: ProjectCreateUploadUrlInput,
  success: ProjectCreateUploadUrlResult,
  error: Schema.Union([
    ProjectTransferError,
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
    GitCloneOperationError,
  ]),
});

export const WsVcsCancelCloneRpc = Rpc.make(WS_METHODS.vcsCancelClone, {
  payload: GitCancelCloneInput,
  success: GitCancelCloneResult,
  error: Schema.Union([GitCommandError, EnvironmentRpcError]),
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

export const WsGitManagerGetRefsRpc = Rpc.make(WS_METHODS.gitManagerGetRefs, {
  payload: GitManagerCwdInput,
  success: GitManagerRefsSnapshot,
  error: GitManagerOperationError,
});

export const WsGitManagerGetCommitsRpc = Rpc.make(WS_METHODS.gitManagerGetCommits, {
  payload: GitManagerGetCommitsInput,
  success: GitManagerCommitPage,
  error: GitManagerOperationError,
});

export const WsGitManagerGetDiffRpc = Rpc.make(WS_METHODS.gitManagerGetDiff, {
  payload: GitManagerGetDiffInput,
  success: GitManagerDiff,
  error: GitManagerOperationError,
});

export const WsGitManagerGetStashesRpc = Rpc.make(WS_METHODS.gitManagerGetStashes, {
  payload: GitManagerCwdInput,
  success: Schema.Array(GitManagerStashEntry),
  error: GitManagerOperationError,
});

export const WsGitManagerGetRemoteTagsRpc = Rpc.make(WS_METHODS.gitManagerGetRemoteTags, {
  payload: GitManagerRemoteTagsInput,
  success: GitManagerRemoteTags,
  error: GitManagerOperationError,
});

export const WsGitManagerPreviewMergeRpc = Rpc.make(WS_METHODS.gitManagerPreviewMerge, {
  payload: GitManagerPreviewMergeInput,
  success: GitManagerMergePreview,
  error: GitManagerOperationError,
});

export const WsGitManagerListPullRequestsRpc = Rpc.make(WS_METHODS.gitManagerListPullRequests, {
  payload: GitManagerCwdInput,
  success: GitManagerPullRequestsResult,
  error: GitManagerOperationError,
});

export const WsGitManagerCommitRpc = Rpc.make(WS_METHODS.gitManagerCommit, {
  payload: GitManagerCommitInput,
  success: GitManagerCommitResult,
  error: GitManagerOperationError,
});

export const WsGitManagerUndoCommitRpc = Rpc.make(WS_METHODS.gitManagerUndoCommit, {
  payload: GitManagerCwdInput,
  success: GitManagerUndoCommitResult,
  error: GitManagerOperationError,
});

export const WsGitManagerDiscardRpc = Rpc.make(WS_METHODS.gitManagerDiscard, {
  payload: GitManagerDiscardInput,
  success: GitManagerDiscardResult,
  error: GitManagerOperationError,
});

export const WsGitManagerStagePartialRpc = Rpc.make(WS_METHODS.gitManagerStagePartial, {
  payload: GitManagerPartialSelectionInput,
  success: GitManagerPartialSelectionResult,
  error: GitManagerOperationError,
});

export const WsGitManagerUnstagePartialRpc = Rpc.make(WS_METHODS.gitManagerUnstagePartial, {
  payload: GitManagerPartialSelectionInput,
  success: GitManagerPartialSelectionResult,
  error: GitManagerOperationError,
});

export const WsGitManagerDiscardPartialRpc = Rpc.make(WS_METHODS.gitManagerDiscardPartial, {
  payload: GitManagerPartialSelectionInput,
  success: GitManagerPartialSelectionResult,
  error: GitManagerOperationError,
});

export const WsGitManagerRunOperationRpc = Rpc.make(WS_METHODS.gitManagerRunOperation, {
  payload: GitManagerOperationRequest,
  success: GitManagerOperationEvent,
  error: GitManagerOperationError,
  stream: true,
});

export const WsSubscribeGitManagerSignalRpc = Rpc.make(WS_METHODS.subscribeGitManagerSignal, {
  payload: GitManagerCwdInput,
  success: GitManagerSignalEvent,
  error: GitManagerOperationError,
  stream: true,
});

export const WsPullRequestsGetContextRpc = Rpc.make(WS_METHODS.pullRequestsGetContext, {
  payload: PullRequestsGetContextInput,
  success: PullRequestsContext,
  error: PullRequestsOperationError,
});

export const WsPullRequestsGetVocabularyRpc = Rpc.make(WS_METHODS.pullRequestsGetVocabulary, {
  payload: PullRequestsVocabularyInput,
  success: PullRequestsVocabulary,
  error: PullRequestsOperationError,
});

export const WsPullRequestsGetCreateDefaultsRpc = Rpc.make(
  WS_METHODS.pullRequestsGetCreateDefaults,
  {
    payload: PullRequestsCwdInput,
    success: PullRequestsCreateDefaults,
    error: PullRequestsOperationError,
  },
);

export const WsPullRequestsListRpc = Rpc.make(WS_METHODS.pullRequestsList, {
  payload: PullRequestsListInput,
  success: PullRequestsListPage,
  error: PullRequestsOperationError,
});

export const WsPullRequestsGetRpc = Rpc.make(WS_METHODS.pullRequestsGet, {
  payload: PullRequestsNumberInput,
  success: PullRequestsDetail,
  error: PullRequestsOperationError,
});

export const WsPullRequestsGetTimelineRpc = Rpc.make(WS_METHODS.pullRequestsGetTimeline, {
  payload: PullRequestsNumberInput,
  success: PullRequestsTimeline,
  error: PullRequestsOperationError,
});

export const WsPullRequestsGetCommitsRpc = Rpc.make(WS_METHODS.pullRequestsGetCommits, {
  payload: PullRequestsNumberInput,
  success: PullRequestsCommits,
  error: PullRequestsOperationError,
});

export const WsPullRequestsGetChecksRpc = Rpc.make(WS_METHODS.pullRequestsGetChecks, {
  payload: PullRequestsNumberInput,
  success: PullRequestsChecks,
  error: PullRequestsOperationError,
});

export const WsPullRequestsGetFilesRpc = Rpc.make(WS_METHODS.pullRequestsGetFiles, {
  payload: PullRequestsNumberInput,
  success: PullRequestsFiles,
  error: PullRequestsOperationError,
});

export const WsPullRequestsRunActionRpc = Rpc.make(WS_METHODS.pullRequestsRunAction, {
  payload: PullRequestsActionRequest,
  success: PullRequestsActionResult,
  error: PullRequestsOperationError,
});

export const WsPullRequestsCheckoutRpc = Rpc.make(WS_METHODS.pullRequestsCheckout, {
  payload: PullRequestsCheckoutInput,
  success: PullRequestsCheckoutResult,
  error: PullRequestsOperationError,
});

export const WsPullRequestsReadSnapshotRpc = Rpc.make(WS_METHODS.pullRequestsReadSnapshot, {
  payload: PullRequestsSubscribeInput,
  success: PullRequestsSnapshot,
  error: PullRequestsOperationError,
});

export const WsPullRequestsSubscribeRpc = Rpc.make(WS_METHODS.pullRequestsSubscribe, {
  payload: PullRequestsSubscribeInput,
  success: PullRequestsChanged,
  error: PullRequestsOperationError,
  stream: true,
});

export const WsPipelinesListRpc = Rpc.make(WS_METHODS.pipelinesList, {
  payload: PipelinesListInput,
  success: PipelinesListPage,
  error: PullRequestsOperationError,
});

export const WsPipelinesGetRpc = Rpc.make(WS_METHODS.pipelinesGet, {
  payload: PipelinesGetInput,
  success: PipelinesDetail,
  error: PullRequestsOperationError,
});

export const WsPipelinesGetJobRpc = Rpc.make(WS_METHODS.pipelinesGetJob, {
  payload: PipelinesJobInput,
  success: PipelinesJobDetail,
  error: PullRequestsOperationError,
});

export const WsPipelinesGetJobLogRpc = Rpc.make(WS_METHODS.pipelinesGetJobLog, {
  payload: PipelinesJobLogInput,
  success: PipelinesJobLog,
  error: PullRequestsOperationError,
});

/** The stored list, pipeline and job copies, read from the database with no host call. */
export const WsPipelinesReadSnapshotRpc = Rpc.make(WS_METHODS.pipelinesReadSnapshot, {
  payload: PipelinesSubscribeInput,
  success: PipelinesSnapshot,
  error: PullRequestsOperationError,
});

/** GitLab only: the cooperative poller names what changed; GitHub answers `unavailable`. */
export const WsPipelinesSubscribeRpc = Rpc.make(WS_METHODS.pipelinesSubscribe, {
  payload: PipelinesSubscribeInput,
  success: PipelinesChanged,
  error: PullRequestsOperationError,
  stream: true,
});

/** Retry, cancel or play a pipeline or job; served when `pipelinesMutations` is advertised. */
export const WsPipelinesRunActionRpc = Rpc.make(WS_METHODS.pipelinesRunAction, {
  payload: PipelinesRunActionInput,
  success: PipelinesActionResult,
  error: PullRequestsOperationError,
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

/** One side of a changed file, for the Diff panel's Compare view. */
export const WsReviewReadFileVersionRpc = Rpc.make(WS_METHODS.reviewReadFileVersion, {
  payload: ReviewReadFileVersionInput,
  success: ReviewReadFileVersionResult,
  error: Schema.Union([WorkspaceUnavailableError, WorkspaceIdentityError, EnvironmentRpcError]),
});

/** The diff apps Git finds where the server runs, for the Diff panel's **Open with**. */
export const WsReviewListDiffToolsRpc = Rpc.make(WS_METHODS.reviewListDiffTools, {
  payload: ReviewListDiffToolsInput,
  success: ReviewListDiffToolsResult,
  error: Schema.Union([WorkspaceUnavailableError, WorkspaceIdentityError, EnvironmentRpcError]),
});

/** Opens a file, or every file, in a diff app on the server's computer through `git difftool`. */
export const WsReviewOpenDiffToolRpc = Rpc.make(WS_METHODS.reviewOpenDiffTool, {
  payload: ReviewOpenDiffToolInput,
  success: ReviewOpenDiffToolResult,
  error: Schema.Union([
    ReviewDiffToolError,
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

const TerminalOrderedInputError = Schema.Union([
  TerminalInputError,
  TerminalError,
  WorkspaceUnavailableError,
  WorkspaceIdentityError,
  EnvironmentRpcError,
]);

export const WsTerminalBeginInputRpc = Rpc.make(WS_METHODS.terminalBeginInput, {
  payload: TerminalBeginInput,
  success: TerminalInputLease,
  error: TerminalOrderedInputError,
});

export const WsTerminalWriteInputRpc = Rpc.make(WS_METHODS.terminalWriteInput, {
  payload: TerminalWriteInputFrame,
  success: TerminalInputAcknowledgement,
  error: TerminalOrderedInputError,
});

export const WsTerminalCancelInputRpc = Rpc.make(WS_METHODS.terminalCancelInput, {
  payload: TerminalCancelInput,
  success: Schema.Null,
  error: TerminalOrderedInputError,
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

export const WsPreviewClaimOpenRequestRpc = Rpc.make(WS_METHODS.previewClaimOpenRequest, {
  payload: PreviewClaimOpenRequestInput,
  success: PreviewClaimOpenRequestResult,
  error: EnvironmentRpcError,
});

export const WsPreviewGatewayOpenRpc = Rpc.make(WS_METHODS.previewGatewayOpen, {
  payload: PreviewGatewayOpenInput,
  success: PreviewGatewayOpenResult,
  error: Schema.Union([PreviewGatewayError, EnvironmentRpcError]),
});

const DeviceRpcFailure = Schema.Union([DeviceRpcError, EnvironmentRpcError]);

export const WsDeviceSubscribeCatalogRpc = Rpc.make(WS_METHODS.deviceSubscribeCatalog, {
  payload: Schema.Struct({}),
  success: DeviceCatalog,
  error: DeviceRpcFailure,
  stream: true,
});

/** Reruns device discovery now, past its 30 s cache; changes arrive on the catalog stream. */
export const WsDeviceRefreshCatalogRpc = Rpc.make(WS_METHODS.deviceRefreshCatalog, {
  payload: Schema.Struct({}),
  error: DeviceRpcFailure,
});

export const WsDeviceOpenRpc = Rpc.make(WS_METHODS.deviceOpen, {
  payload: DeviceOpenInput,
  success: DeviceOpenResult,
  error: DeviceRpcFailure,
});

export const WsDeviceCloseRpc = Rpc.make(WS_METHODS.deviceClose, {
  payload: DeviceIdInput,
  error: DeviceRpcFailure,
});

export const WsDeviceInputRpc = Rpc.make(WS_METHODS.deviceInput, {
  payload: DeviceInputInput,
  error: DeviceRpcFailure,
});

export const WsDeviceRotateRpc = Rpc.make(WS_METHODS.deviceRotate, {
  payload: DeviceRotateInput,
  success: DeviceRotateResult,
  error: DeviceRpcFailure,
});

export const WsDeviceSubscribeFramesRpc = Rpc.make(WS_METHODS.deviceSubscribeFrames, {
  payload: DeviceIdInput,
  success: DeviceJpegFrame,
  error: DeviceRpcFailure,
  stream: true,
});

export const WsDeviceCreateMediaTicketRpc = Rpc.make(WS_METHODS.deviceCreateMediaTicket, {
  payload: DeviceIdInput,
  success: DeviceMediaTicket,
  error: DeviceRpcFailure,
});

export const WsPreviewTunnelOpenRpc = Rpc.make(WS_METHODS.previewTunnelOpen, {
  payload: PreviewTunnelOpenInput,
  success: PreviewTunnelEvent,
  error: Schema.Union([PreviewTunnelError, EnvironmentRpcError]),
  stream: true,
});

export const WsPreviewTunnelWriteRpc = Rpc.make(WS_METHODS.previewTunnelWrite, {
  payload: PreviewTunnelWriteInput,
  error: Schema.Union([PreviewTunnelError, EnvironmentRpcError]),
});

export const WsPreviewTunnelCloseRpc = Rpc.make(WS_METHODS.previewTunnelClose, {
  payload: PreviewTunnelCloseInput,
  error: Schema.Union([PreviewTunnelError, EnvironmentRpcError]),
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
      UploadError,
      WorkspaceUnavailableError,
      WorkspaceIdentityError,
      EnvironmentRpcError,
    ]),
  },
);

export const WsOrchestrationGetTurnDiffRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getTurnDiff, {
  payload: OrchestrationGetTurnDiffInput,
  success: OrchestrationRpcSchemas.getTurnDiff.output,
  error: Schema.Union([
    OrchestrationGetTurnDiffError,
    WorkspaceUnavailableError,
    EnvironmentRpcError,
  ]),
});

export const WsOrchestrationGetFullThreadDiffRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getFullThreadDiff,
  {
    payload: OrchestrationGetFullThreadDiffInput,
    success: OrchestrationRpcSchemas.getFullThreadDiff.output,
    error: Schema.Union([
      OrchestrationGetFullThreadDiffError,
      WorkspaceUnavailableError,
      EnvironmentRpcError,
    ]),
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

/** The agent activity log and who is active (#139, slice X1); needs `access:read`. */
export const WsSubscribeMcpActivityRpc = Rpc.make(WS_METHODS.subscribeMcpActivity, {
  payload: Schema.Struct({}),
  success: McpActivityStreamEvent,
  error: Schema.Union([McpActivityError, EnvironmentRpcError]),
  stream: true,
});

/**
 * Publishes an outside agent's UI suggestion (#139, slice X4). Only an `mcp-client` session
 * may publish; clients only raise a notice, and nothing moves until a person clicks Show.
 */
export const WsUiPublishIntentRpc = Rpc.make(WS_METHODS.uiPublishIntent, {
  payload: UiPublishIntentInput,
  success: UiPublishIntentResult,
  error: Schema.Union([UiIntentError, EnvironmentRpcError]),
});

/** The pending UI suggestions, then each new one (#139, slice X4). */
export const WsSubscribeUiIntentsRpc = Rpc.make(WS_METHODS.subscribeUiIntents, {
  payload: Schema.Struct({}),
  success: UiIntentStreamEvent,
  error: EnvironmentRpcError,
  stream: true,
});

/** The webhook endpoints and whether webhooks are on (#139, slice X8). `access:read`. */
export const WsWebhooksListRpc = Rpc.make(WS_METHODS.webhooksList, {
  payload: WebhooksListInput,
  success: WebhooksListResult,
  error: Schema.Union([WebhookError, EnvironmentRpcError]),
});

/** One endpoint's recent deliveries, newest first. `access:read`. */
export const WsWebhooksListDeliveriesRpc = Rpc.make(WS_METHODS.webhooksListDeliveries, {
  payload: WebhooksListDeliveriesInput,
  success: WebhooksListDeliveriesResult,
  error: Schema.Union([WebhookError, EnvironmentRpcError]),
});

/** Adds or edits an endpoint; a new one's secret is returned once. `access:write`. */
export const WsWebhooksUpsertRpc = Rpc.make(WS_METHODS.webhooksUpsert, {
  payload: WebhooksUpsertInput,
  success: WebhooksUpsertResult,
  error: Schema.Union([WebhookError, EnvironmentRpcError]),
});

/** Deletes an endpoint with its delivery log and secret. `access:write`. */
export const WsWebhooksDeleteRpc = Rpc.make(WS_METHODS.webhooksDelete, {
  payload: WebhooksEndpointInput,
  success: WebhooksDeleteResult,
  error: Schema.Union([WebhookError, EnvironmentRpcError]),
});

/** Replaces an endpoint's secret and returns the new one once. `access:write`. */
export const WsWebhooksRotateSecretRpc = Rpc.make(WS_METHODS.webhooksRotateSecret, {
  payload: WebhooksEndpointInput,
  success: WebhooksRotateSecretResult,
  error: Schema.Union([WebhookError, EnvironmentRpcError]),
});

/** Sends `webhook.test` now and answers with the result. `access:write`. */
export const WsWebhooksSendTestRpc = Rpc.make(WS_METHODS.webhooksSendTest, {
  payload: WebhooksEndpointInput,
  success: WebhooksSendResult,
  error: Schema.Union([WebhookError, EnvironmentRpcError]),
});

/** Sends a logged delivery's event again now. `access:write`. */
export const WsWebhooksRedeliverRpc = Rpc.make(WS_METHODS.webhooksRedeliver, {
  payload: WebhooksRedeliverInput,
  success: WebhooksSendResult,
  error: Schema.Union([WebhookError, EnvironmentRpcError]),
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

export const WsUploadsBeginRpc = Rpc.make(WS_METHODS.uploadsBegin, {
  payload: UploadBeginInput,
  success: UploadBeginResult,
  error: Schema.Union([UploadError, EnvironmentRpcError]),
});
export const WsUploadsAppendRpc = Rpc.make(WS_METHODS.uploadsAppend, {
  payload: UploadAppendInput,
  success: UploadAppendResult,
  error: Schema.Union([UploadError, EnvironmentRpcError]),
});
export const WsUploadsGetRpc = Rpc.make(WS_METHODS.uploadsGet, {
  payload: UploadGetInput,
  success: UploadGetResult,
  error: Schema.Union([UploadError, EnvironmentRpcError]),
});
export const WsUploadsCancelRpc = Rpc.make(WS_METHODS.uploadsCancel, {
  payload: UploadCancelInput,
  success: UploadCancelResult,
  error: Schema.Union([UploadError, EnvironmentRpcError]),
});
export const WsTerminalStageImagePasteRpc = Rpc.make(WS_METHODS.terminalStageImagePaste, {
  payload: TerminalStageImagePasteInput,
  success: TerminalStageImagePasteResult,
  error: Schema.Union([UploadError, EnvironmentRpcError]),
});

export const WsRpcGroup = RpcGroup.make(
  WsUploadsBeginRpc,
  WsUploadsAppendRpc,
  WsUploadsGetRpc,
  WsUploadsCancelRpc,
  WsAuthConfirmPairingRpc,
  WsAgentSessionsScanRpc,
  WsAgentSessionsImportRpc,
  WsAgentSessionsListForThreadRpc,
  WsAgentSessionsOpenInPanelRpc,
  WsServerGetConfigRpc,
  WsServerGetProviderCapabilitiesRpc,
  WsServerRefreshProvidersRpc,
  WsServerUpdateProviderRpc,
  WsServerUpsertKeybindingRpc,
  WsServerRemoveKeybindingRpc,
  WsServerGetSettingsRpc,
  WsServerUpdateSettingsRpc,
  WsServerDiscoverSourceControlRpc,
  WsServerGetTraceDiagnosticsRpc,
  WsServerDownloadDiagnosticLogsRpc,
  WsServerSubscribeDiagnosticLogsRelayRpc,
  WsServerClaimDiagnosticLogsRelayRpc,
  WsServerSendDiagnosticLogsRelayItemRpc,
  WsServerGetProcessDiagnosticsRpc,
  WsServerGetProcessResourceHistoryRpc,
  WsServerGetProfilerStatusRpc,
  WsServerReportProfilerClientBatchRpc,
  WsServerSignalProcessRpc,
  WsServerGetProviderUsageRpc,
  WsServerRefreshProviderUsageRpc,
  WsServerConsumeCodexRateLimitResetRpc,
  WsUpdaterActiveWorkRpc,
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
  WsProjectsGetFileVersionRpc,
  WsProjectsSearchEntriesRpc,
  WsProjectsWriteFileRpc,
  WsProjectsWriteFileIfUnchangedRpc,
  WsProjectsCreateEntryRpc,
  WsProjectsRenameEntryRpc,
  WsProjectsDeleteEntryRpc,
  WsProjectsDuplicateEntryRpc,
  WsShellOpenInEditorRpc,
  WsFilesystemBrowseRpc,
  WsAssetsCreateUrlRpc,
  WsProjectsCreateDownloadUrlRpc,
  WsProjectsCreateUploadUrlRpc,
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
  WsVcsCancelCloneRpc,
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
  WsGitManagerGetRefsRpc,
  WsGitManagerGetCommitsRpc,
  WsGitManagerGetDiffRpc,
  WsGitManagerGetStashesRpc,
  WsGitManagerGetRemoteTagsRpc,
  WsGitManagerPreviewMergeRpc,
  WsGitManagerListPullRequestsRpc,
  WsGitManagerCommitRpc,
  WsGitManagerUndoCommitRpc,
  WsGitManagerDiscardRpc,
  WsGitManagerStagePartialRpc,
  WsGitManagerUnstagePartialRpc,
  WsGitManagerDiscardPartialRpc,
  WsGitManagerRunOperationRpc,
  WsSubscribeGitManagerSignalRpc,
  WsPullRequestsGetContextRpc,
  WsPullRequestsGetVocabularyRpc,
  WsPullRequestsGetCreateDefaultsRpc,
  WsPullRequestsListRpc,
  WsPullRequestsGetRpc,
  WsPullRequestsGetTimelineRpc,
  WsPullRequestsGetCommitsRpc,
  WsPullRequestsGetChecksRpc,
  WsPullRequestsGetFilesRpc,
  WsPullRequestsRunActionRpc,
  WsPullRequestsCheckoutRpc,
  WsPullRequestsReadSnapshotRpc,
  WsPullRequestsSubscribeRpc,
  WsPipelinesListRpc,
  WsPipelinesGetRpc,
  WsPipelinesGetJobRpc,
  WsPipelinesGetJobLogRpc,
  WsPipelinesReadSnapshotRpc,
  WsPipelinesSubscribeRpc,
  WsPipelinesRunActionRpc,
  WsReviewGetDiffPreviewRpc,
  WsReviewReadFileVersionRpc,
  WsReviewListDiffToolsRpc,
  WsReviewOpenDiffToolRpc,
  WsTerminalOpenRpc,
  WsTerminalAttachRpc,
  WsTerminalWriteRpc,
  WsTerminalBeginInputRpc,
  WsTerminalWriteInputRpc,
  WsTerminalCancelInputRpc,
  WsTerminalResizeRpc,
  WsTerminalClearRpc,
  WsTerminalRestartRpc,
  WsTerminalCloseRpc,
  WsTerminalStageImagePasteRpc,
  WsSubscribeTerminalEventsRpc,
  WsSubscribeTerminalMetadataRpc,
  WsPreviewOpenRpc,
  WsPreviewNavigateRpc,
  WsPreviewResizeRpc,
  WsPreviewRefreshRpc,
  WsPreviewCloseRpc,
  WsPreviewListRpc,
  WsPreviewReportStatusRpc,
  WsPreviewClaimOpenRequestRpc,
  WsPreviewGatewayOpenRpc,
  WsPreviewTunnelOpenRpc,
  WsPreviewTunnelWriteRpc,
  WsPreviewTunnelCloseRpc,
  WsPreviewAutomationConnectRpc,
  WsPreviewAutomationRespondRpc,
  WsPreviewAutomationFocusHostRpc,
  WsDeviceSubscribeCatalogRpc,
  WsDeviceRefreshCatalogRpc,
  WsDeviceOpenRpc,
  WsDeviceCloseRpc,
  WsDeviceInputRpc,
  WsDeviceRotateRpc,
  WsDeviceSubscribeFramesRpc,
  WsDeviceCreateMediaTicketRpc,
  WsSubscribePreviewEventsRpc,
  WsSubscribeDiscoveredLocalServersRpc,
  WsSubscribeServerConfigRpc,
  WsSubscribeServerLifecycleRpc,
  WsSubscribeAuthAccessRpc,
  WsSubscribeMcpActivityRpc,
  WsUiPublishIntentRpc,
  WsSubscribeUiIntentsRpc,
  WsWebhooksListRpc,
  WsWebhooksListDeliveriesRpc,
  WsWebhooksUpsertRpc,
  WsWebhooksDeleteRpc,
  WsWebhooksRotateSecretRpc,
  WsWebhooksSendTestRpc,
  WsWebhooksRedeliverRpc,
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
