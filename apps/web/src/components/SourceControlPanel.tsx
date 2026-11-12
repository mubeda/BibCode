import { scopedThreadKey } from "@bibcode/client-runtime/environment";
import {
  type DefaultAgentSelection,
  GitSignInRequiredError,
  type GitActionProgressEvent,
  type GitManagerOperationEvent,
  type GitManagerOperationRequest,
  type GitManagerRefEntry,
  type GitRunStackedActionInput,
  type GitStackedAction,
  type ProjectId,
  type ScopedProjectRef,
  type ScopedThreadRef,
  type VcsPullInput,
  type VcsStagingArea,
  type VcsStatusResult,
} from "@bibcode/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@bibcode/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import {
  ChevronDownIcon,
  CloudUploadIcon,
  DownloadIcon,
  FolderTreeIcon,
  GitCommitIcon,
  ListChecksIcon,
  ListIcon,
  ScanSearchIcon,
  SparklesIcon,
  SquareIcon,
  Undo2Icon,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { Textarea } from "~/components/ui/textarea";
import { stackedThreadToast, toastManager, type ThreadToastData } from "~/components/ui/toast";
import { GitSignInPrompt } from "~/components/gitSignIn/GitSignInPrompt";
import { SIGN_IN_REPEATED_MESSAGE } from "~/components/gitSignIn/gitSignIn.logic";
import { useGitSignInFlow } from "~/components/gitSignIn/useGitSignInFlow";
import { useDiffPanelStore } from "~/diffPanelStore";
import { usePreferredEditor } from "~/editorPreferences";
import { usePrimarySettings } from "~/hooks/useSettings";
import { openPullRequestLink } from "~/lib/openPullRequestLink";
import {
  useGitStackedAction,
  useSourceControlActionRunning,
  useVcsDiscardAction,
  useVcsGenerateCommitMessageAction,
  useVcsPullAction,
  useVcsStageAction,
  useVcsUnstageAction,
} from "~/lib/sourceControlActions";
import { cn, randomUUID } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { useRightPanelStore } from "~/rightPanelStore";
import { useSourceControlPanelStore } from "~/sourceControlPanelStore";
import { getSourceControlPresentation } from "~/sourceControlPresentation";
import { useSourceControlDraft } from "~/sourceControlDraft";
import { useServerConfigs } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import {
  gitManagerEnvironment,
  type GitManagerOperationHandle,
  useRunGitManagerOperation,
} from "~/state/gitManager";
import { useEnvironmentQuery } from "~/state/query";
import { primaryServerAvailableEditorsAtom } from "~/state/server";
import { shellEnvironment } from "~/state/shell";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { vcsEnvironment } from "~/state/vcs";

import { DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { joinWorkspacePath } from "./files/FileTreeContextMenu.logic";
import {
  buildMenuItems,
  type DefaultBranchConfirmableAction,
  requiresDefaultBranchConfirmation,
  resolveDefaultBranchActionDialogCopy,
  resolveQuickAction,
  stackedActionFailureTitle,
} from "./GitActionsControl.logic";
import { SourceControlAgentSuggestion } from "./SourceControlAgentSuggestion";
import { SourceControlDraftConflict } from "./SourceControlDraftConflict";
import { SourceControlChangesList } from "./SourceControlChangesList";
import { SourceControlCommits } from "./SourceControlCommits";
import {
  BUSY_REASON,
  buildSourceControlMenuItems,
  resolveSourceControlPrimaryAction,
  type SourceControlMenuItem,
} from "./SourceControlPrimaryAction.logic";
import {
  appendGitignorePattern,
  discardPathsOf,
  groupFilesByArea,
  ignoreFileNamePattern,
  ignoreParentFolderPattern,
  isFileStaged,
  type CodeReviewScope,
  codeReviewTooltip,
  type PendingDiscard,
  resolveCodeReviewButtonState,
  resolveCodeReviewScope,
  resolveDiscardDialogCopy,
  resolveStagingToggleAction,
  resolveVsBaseLabel,
  summarizeChangeSelection,
  type WorkingTreeFile,
  workingTreeFiles,
} from "./SourceControlPanel.logic";
import { GIT_MANAGER_STASH_MERGE_DISABLED_REASON } from "./gitManager/gitManagerAvailability";
import { GitManagerInProgressStrip } from "./gitManager/GitManagerInProgressStrip";
import { GitManagerMergeDialog } from "./gitManager/merge/GitManagerMergeDialog";
import { GitManagerOperationBanner } from "./gitManager/toolbar/GitManagerOperationBanner";
import { canOpenPullRequestInPanel } from "./pullRequests/pullRequestsAvailability";
import { SourceControlMergeChanges } from "./SourceControlMergeChanges";
import { CodeReviewInstructionsDialog } from "./sourceControl/CodeReviewInstructionsDialog";
import { CodeReviewProjectPromptDialog } from "./sourceControl/CodeReviewProjectPromptDialog";
import { CODE_REVIEW_SERVER_UPDATE_REASON, type CodeReviewMenuReviewer } from "~/codeReview";
import {
  GitManagerCreatePullRequestDialog,
  type GitManagerCreatePullRequestDialogProps,
} from "./gitManager/provider/GitManagerCreatePullRequestDialog";

interface SourceControlPanelProps {
  mode: DiffPanelMode;
  threadRef: ScopedThreadRef;
  gitCwd: string | null;
  workspaceUnavailable?: string | null;
  /** The thread's project; Git Manager operations (fetch, merge) are scoped to it. */
  projectRef?: ScopedProjectRef | null;
  /** "Review changes" (#293); absent hides the button. */
  codeReview?: {
    readonly unavailableReason: string | null;
    readonly guardLine: string | null;
    /** `reviewer` is a one-off pick from the review menu; absent means the saved reviewer. */
    readonly onStart: (
      scope: CodeReviewScope,
      reviewer?: DefaultAgentSelection,
      instructions?: string,
    ) => void;
    /** The reviewers the review menu offers for one review (R103). */
    readonly reviewers?: ReadonlyArray<CodeReviewMenuReviewer>;
    /** The thread's project, whose review prompt the menu edits; `null` hides the menu. */
    readonly projectId: ProjectId | null;
    readonly projectPrompt: string;
    readonly userPrompt: string;
  } | null;
}

const EMPTY_REFS: ReadonlyArray<GitManagerRefEntry> = Object.freeze([]);
const MERGE_IN_PROGRESS = { kind: "merge", current: null, total: null } as const;
const EMPTY_REMOTES: ReadonlyArray<string> = Object.freeze([]);

const RUNNING_ACTIONS = [
  "runStackedAction",
  "pull",
  "stageFiles",
  "unstageFiles",
  "discardFiles",
] as const;

// Legacy servers (no staging areas) don't support the stage/unstage RPCs, so
// their single flat section renders no checkbox and never invokes onToggle.
const LEGACY_NOOP_TOGGLE = () => {};

function sourceControlErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.trim()
  ) {
    return error.message;
  }
  return "An error occurred.";
}

function isDefaultBranchConfirmable(
  action: GitStackedAction,
): action is DefaultBranchConfirmableAction {
  return (
    action === "push" ||
    action === "create_pr" ||
    action === "commit_push" ||
    action === "commit_push_pr"
  );
}

export default function SourceControlPanel({
  mode,
  threadRef,
  gitCwd,
  workspaceUnavailable = null,
  projectRef = null,
  codeReview = null,
}: SourceControlPanelProps) {
  const environmentId = threadRef.environmentId;
  const scope = useMemo(() => ({ environmentId, cwd: gitCwd }), [environmentId, gitCwd]);
  const pullRequestsEnabled = usePrimarySettings((settings) => settings.pullRequestsEnabled);

  const statusQuery = useEnvironmentQuery(
    gitCwd === null || workspaceUnavailable !== null
      ? null
      : vcsEnvironment.status({ environmentId, input: { cwd: gitCwd } }),
  );
  const status: VcsStatusResult | null = statusQuery.data ?? null;

  const draft = useSourceControlDraft({
    environmentId,
    cwd: gitCwd ?? "",
    legacyThreadKey: scopedThreadKey(threadRef),
  });
  const { clear: clearDraft, setMessage: setDraftMessage } = draft;

  const groupByFolder = useSourceControlPanelStore((state) => state.sourceControlGroupByFolder);
  const setGroupByFolder = useSourceControlPanelStore(
    (state) => state.setSourceControlGroupByFolder,
  );

  const runAction = useGitStackedAction(scope);
  const signIn = useGitSignInFlow(environmentId);
  const offerSignIn = signIn.offer;
  const runPullRef = useRef<((resume?: VcsPullInput) => Promise<void>) | null>(null);
  const runResumedPushRef = useRef<
    ((resume: GitRunStackedActionInput, onPushed?: () => void) => Promise<void>) | null
  >(null);
  const capabilities = useServerConfigs().get(environmentId)?.environment.capabilities;
  const pullRequestBranchSelection = capabilities?.gitPullRequestBranchSelection === true;
  const mergeAvailable =
    capabilities?.gitManagerStashMergeOperations === true &&
    capabilities?.gitManagerBranchSyncOperations === true &&
    projectRef !== null &&
    gitCwd !== null;
  const pullAction = useVcsPullAction(scope);
  const stageAction = useVcsStageAction(scope);
  const unstageAction = useVcsUnstageAction(scope);
  const discardAction = useVcsDiscardAction(scope);
  const generateAction = useVcsGenerateCommitMessageAction(scope);
  const generationTokenRef = useRef(0);
  const vcsBusy = useSourceControlActionRunning(scope, RUNNING_ACTIONS);
  // Fetch and merge run as Git Manager operations, outside the vcs action manager.
  const [mergeOperationRunning, setMergeOperationRunning] = useState(false);
  const isBusy = vcsBusy || mergeOperationRunning;
  const runOperation = useRunGitManagerOperation();
  const recoveryHandleRef = useRef<GitManagerOperationHandle | null>(null);
  const [recoveryEvent, setRecoveryEvent] = useState<GitManagerOperationEvent | null>(null);
  useEffect(() => () => recoveryHandleRef.current?.cancel(), []);
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  // Refs (with remotes) load only while the merge dialog is open.
  const refsQuery = useEnvironmentQuery(
    mergeDialogOpen && gitCwd !== null
      ? (gitManagerEnvironment.getRefs?.({ environmentId, input: { cwd: gitCwd } }) ?? null)
      : null,
  );

  const [pendingConfirm, setPendingConfirm] = useState<{
    action: DefaultBranchConfirmableAction;
    branchName: string;
    includesCommit: boolean;
  } | null>(null);
  const [pendingPullRequest, setPendingPullRequest] = useState<{
    scope: GitManagerCreatePullRequestDialogProps["scope"];
    commitInput?: GitManagerCreatePullRequestDialogProps["commitInput"];
  } | null>(null);
  // Files staged for discard, awaiting the destructive-action confirm dialog.
  const [pendingDiscard, setPendingDiscard] = useState<PendingDiscard | null>(null);
  // Bumped on every successful git action so <SourceControlCommits> refetches.
  // `nowMs` is the stable clock for relative commit timestamps: it only advances
  // with a bump, not on every keystroke in the message box.
  const [commitReload, setCommitReload] = useState(() => ({ signal: 0, nowMs: Date.now() }));
  const reloadCommits = useCallback(() => {
    const nowMs = Date.now();
    setCommitReload((current) => ({ signal: current.signal + 1, nowMs }));
  }, []);
  const [selectionMode, setSelectionMode] = useState(false);
  const [restoreSelectFocus, setRestoreSelectFocus] = useState(false);
  const [selectedFilePaths, setSelectedFilePaths] = useState<ReadonlySet<string>>(() => new Set());
  const selectionSessionRef = useRef(0);
  const ignoreMutationRef = useRef<symbol | null>(null);
  const [ignorePending, setIgnorePending] = useState(false);

  const files = useMemo(() => workingTreeFiles(status), [status]);
  const mergeInProgress = status?.operationInProgress === "merge";
  // A complete scope is required to build any merge recovery request.
  const recoveryScope =
    projectRef !== null && gitCwd !== null
      ? { cwd: gitCwd, projectId: projectRef.projectId }
      : null;
  const mergeRecoveryShown = mergeInProgress && recoveryScope !== null;
  const groups = useMemo(
    () => groupFilesByArea(files, { separateConflicts: mergeRecoveryShown }),
    [files, mergeRecoveryShown],
  );
  const runRecovery = useCallback(
    (input: GitManagerOperationRequest) => {
      if (recoveryHandleRef.current !== null) return;
      setMergeOperationRunning(true);
      setRecoveryEvent({ _tag: "started", operation: input._tag });
      const handle = runOperation({ environmentId, input }, (event) => {
        setRecoveryEvent(event);
        // The merge commit now exists; the commit history reloads on this token.
        if (event._tag === "finished" && input._tag === "continue") {
          reloadCommits();
        }
      });
      recoveryHandleRef.current = handle;
      void handle.result.then((result) => {
        if (recoveryHandleRef.current === handle) recoveryHandleRef.current = null;
        setMergeOperationRunning(false);
        if (result._tag !== "Failure") return;
        if (Cause.hasInterruptsOnly(result.cause)) {
          setRecoveryEvent(null);
          return;
        }
        const error = Cause.squash(result.cause);
        setRecoveryEvent({
          _tag: "failed",
          operation: input._tag,
          code: "transport-error",
          message: error instanceof Error ? error.message : "The Git operation failed.",
          blocked: null,
        });
      });
    },
    [environmentId, reloadCommits, runOperation],
  );
  const cancelRecovery = useCallback(() => {
    recoveryHandleRef.current?.cancel();
  }, []);
  const stripDisabledReason =
    (mergeAvailable ? null : GIT_MANAGER_STASH_MERGE_DISABLED_REASON) ??
    (mergeOperationRunning ? "A merge is running." : vcsBusy ? BUSY_REASON : null);
  const selectedFiles = useMemo(
    () => files.filter((file) => selectedFilePaths.has(file.path)),
    [files, selectedFilePaths],
  );
  const selectedPaths = useMemo(
    () => [...new Set(selectedFiles.map((file) => file.path))],
    [selectedFiles],
  );
  const selectedAllUntracked =
    selectedFiles.length > 0 && selectedFiles.every((file) => file.area === "untracked");
  // Legacy servers omit the optional `area` field; when none carry it we fall
  // back to Plan-01 behavior (one flat list, commit by explicit filePaths).
  const hasAreas = useMemo(
    () => files.length === 0 || files.some((file) => file.area !== undefined),
    [files],
  );
  const activeSelectionMode = files.length > 0 && hasAreas && selectionMode;
  const generateFilePaths = useMemo(() => {
    const staged = files.filter((file) => file.area === "staged").map((file) => file.path);
    return staged.length > 0 ? staged : files.map((file) => file.path);
  }, [files]);
  const summary = useMemo(() => summarizeChangeSelection(files), [files]);
  const presentation = useMemo(
    () => getSourceControlPresentation(status?.sourceControlProvider),
    [status?.sourceControlProvider],
  );
  const terminology = presentation.terminology;
  const isDefaultRef = status?.isDefaultRef ?? false;
  const hasPrimaryRemote = status?.hasPrimaryRemote ?? false;
  const vsBaseLabel = useMemo(() => resolveVsBaseLabel(status), [status]);
  const [reviewPromptDialogOpen, setReviewPromptDialogOpen] = useState(false);
  const [reviewInstructionsOpen, setReviewInstructionsOpen] = useState(false);
  // An older server would drop the project prompt without an error (D47).
  const codeReviewsSupported = capabilities?.codeReviews === true;
  // Read once at the click: a later status change does not alter a started review.
  const codeReviewScope = useMemo(() => resolveCodeReviewScope(status), [status]);
  const codeReviewUnavailableReason = codeReview?.unavailableReason ?? null;
  const codeReviewButton = useMemo(
    () =>
      resolveCodeReviewButtonState({
        status,
        scope: codeReviewScope,
        unavailableReason: codeReviewUnavailableReason,
      }),
    [codeReviewScope, codeReviewUnavailableReason, status],
  );
  const codeReviewMenuReviewers = codeReview?.reviewers;
  const codeReviewMenuItems = useMemo(
    () =>
      (codeReviewMenuReviewers ?? []).map((reviewer) => ({
        reviewer,
        state: resolveCodeReviewButtonState({
          status,
          scope: codeReviewScope,
          unavailableReason: reviewer.disabledReason,
        }),
      })),
    [codeReviewMenuReviewers, codeReviewScope, status],
  );

  // Legacy servers (no staging areas) keep the chat-header cascade
  // (commit_push-first, commit-by-filePaths). The primary button and dropdown
  // below fork on `hasAreas`: this pair drives the legacy branch unchanged.
  const quickAction = useMemo(
    () => resolveQuickAction(status, isBusy, isDefaultRef, hasPrimaryRemote),
    [status, isBusy, isDefaultRef, hasPrimaryRemote],
  );
  const canOpenInPanel = canOpenPullRequestInPanel({
    enabled: pullRequestsEnabled,
    providerKind: status?.sourceControlProvider?.kind ?? "unknown",
  });
  const menuItems = useMemo(
    () => buildMenuItems(status, isBusy, hasPrimaryRemote, canOpenInPanel),
    [status, isBusy, hasPrimaryRemote, canOpenInPanel],
  );

  // Staging-area servers use the commit-first Source Control ladder (staged ->
  // Commit, else Stage All, else the remote ladder).
  const stagedCount = groups.staged.length;
  const stageableCount = groups.unstaged.length + groups.untracked.length;
  const primaryActionInput = useMemo(
    () => ({
      gitStatus: status,
      isBusy,
      isDefaultRef,
      hasPrimaryRemote,
      stagedCount,
      stageableCount,
      mergeAvailable,
      canOpenInPanel,
    }),
    [
      status,
      isBusy,
      isDefaultRef,
      hasPrimaryRemote,
      stagedCount,
      stageableCount,
      mergeAvailable,
      canOpenInPanel,
    ],
  );
  const primaryAction = useMemo(
    () => resolveSourceControlPrimaryAction(primaryActionInput),
    [primaryActionInput],
  );
  const scMenuItems = useMemo(
    () => buildSourceControlMenuItems(primaryActionInput),
    [primaryActionInput],
  );

  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const isPrimaryEnv = primaryEnvironmentId !== null && environmentId === primaryEnvironmentId;
  const availableEditors = useAtomValue(primaryServerAvailableEditorsAtom);
  const [preferredEditor] = usePreferredEditor(availableEditors);
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, "open in editor");
  const readProjectFile = useAtomQueryRunner(projectEnvironment.readFile, {
    reportFailure: false,
  });
  const writeProjectFile = useAtomCommand(projectEnvironment.writeFile, {
    reportFailure: false,
  });

  const threadToastData = useMemo(() => ({ threadRef }), [threadRef]);

  // Selection mode ends by itself once no selectable files remain, and the
  // selection keeps only paths that still exist.
  if (selectionMode && (files.length === 0 || !hasAreas)) {
    setSelectionMode(false);
    if (selectedFilePaths.size > 0) setSelectedFilePaths(new Set());
    if (pendingDiscard?.kind === "bulk") setPendingDiscard(null);
  } else if (selectedFilePaths.size > 0) {
    const available = new Set(files.map((file) => file.path));
    const next = new Set([...selectedFilePaths].filter((path) => available.has(path)));
    if (next.size !== selectedFilePaths.size) setSelectedFilePaths(next);
  }
  // Leaving selection mode, the automatic exit included, ends its session, so a
  // pending Ignore does not exit it again.
  const wasSelectingRef = useRef(selectionMode);
  useEffect(() => {
    if (wasSelectingRef.current && !selectionMode) selectionSessionRef.current += 1;
    wasSelectingRef.current = selectionMode;
  }, [selectionMode]);

  const runGitAction = useCallback(
    async (action: GitStackedAction, options?: { skipConfirm?: boolean }) => {
      const actionCanCommit =
        action === "commit" || action === "commit_push" || action === "commit_push_pr";
      if (
        !options?.skipConfirm &&
        isDefaultBranchConfirmable(action) &&
        requiresDefaultBranchConfirmation(action, isDefaultRef) &&
        status?.refName
      ) {
        setPendingConfirm({
          action,
          branchName: status.refName,
          includesCommit:
            actionCanCommit && (action === "commit_push" ? status.hasWorkingTreeChanges : true),
        });
        return;
      }

      const submittedDraft = draft.message;
      const message = submittedDraft.trim();
      // Commit semantics:
      //  - Real staging server (hasAreas): commit the staged index as-is; never
      //    send filePaths (which would trigger the legacy reset+add path).
      //  - Legacy server (no areas): commit by passing every path explicitly.
      //  - Non-commit actions (push/create_pr): send neither.
      const commitInput: { commitStagedIndexAsIs?: true; filePaths?: string[] } = actionCanCommit
        ? hasAreas
          ? { commitStagedIndexAsIs: true }
          : files.length > 0
            ? { filePaths: files.map((file) => file.path) }
            : {}
        : {};
      if (action === "commit_push_pr") {
        if (gitCwd === null) return;
        setPendingPullRequest({
          scope: { environmentId, cwd: gitCwd },
          commitInput: { ...commitInput, ...(message ? { commitMessage: message } : {}) },
        });
        return;
      }
      if (action === "create_pr") {
        if (gitCwd === null) return;
        // Publish first only where a plain push is the explicit
        // `push --set-upstream origin <branch>`. A tracked branch may follow a
        // differently named or non-origin upstream; the dialog's create action
        // publishes it to origin explicitly. When the dialog cannot create (no
        // branch-selection support, no identified host, or uncommitted changes),
        // nothing is pushed.
        if (
          !pullRequestBranchSelection ||
          status?.sourceControlProvider == null ||
          status.hasWorkingTreeChanges ||
          status.hasUpstream !== false
        ) {
          setPendingPullRequest({ scope: { environmentId, cwd: gitCwd } });
          return;
        }
      }
      const toastId = toastManager.add({
        type: "loading",
        title: "Running source control action…",
        description: "Waiting for Git…",
        timeout: 0,
        data: threadToastData,
      });
      const push = trackPushPhase(toastId, threadToastData);
      // Create MR/PR publishes the branch first, then reviews it in the shared dialog.
      const result = await runAction.run({
        actionId: randomUUID(),
        action: action === "create_pr" ? "push" : action,
        ...(message ? { commitMessage: message } : {}),
        ...commitInput,
        onProgress: push.onProgress,
        signal: push.signal,
      });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) {
          closeOrReportCancelledPush(toastId, push.signal, threadToastData);
          return;
        }
        const offer = push.failure()?.signIn;
        if (offer !== undefined && gitCwd !== null) {
          toastManager.close(toastId);
          // Create MR/PR still owes its review dialog once the resumed push publishes the branch.
          const onPushed =
            action === "create_pr"
              ? () => setPendingPullRequest({ scope: { environmentId, cwd: gitCwd } })
              : undefined;
          offerSignIn({
            offer,
            cwd: gitCwd,
            onSignedIn: () => void runResumedPushRef.current?.(offer.resume, onPushed),
            onEnded: (_code, message) =>
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Push failed",
                  description: message,
                  data: threadToastData,
                }),
              ),
          });
          return;
        }
        const error = squashAtomCommandFailure(result);
        toastManager.update(
          toastId,
          stackedThreadToast({
            type: "error",
            title: stackedActionFailureTitle(error),
            description: sourceControlErrorMessage(error),
            data: threadToastData,
          }),
        );
        return;
      }
      // Commit succeeded: clear the drafted message.
      if (actionCanCommit) {
        clearDraft(submittedDraft);
      }
      // Refresh the commits list (and the relative-time clock) after any success.
      reloadCommits();
      toastManager.update(toastId, {
        type: "success",
        title: result.value.toast.title,
        description: result.value.toast.description,
        timeout: 0,
        data: { ...threadToastData, dismissAfterVisibleMs: 10_000 },
      });
      if (action === "create_pr" && gitCwd !== null) {
        setPendingPullRequest({ scope: { environmentId, cwd: gitCwd } });
      }
    },
    [
      draft.message,
      clearDraft,
      files,
      hasAreas,
      isDefaultRef,
      runAction,
      status,
      threadToastData,
      gitCwd,
      environmentId,
      pullRequestBranchSelection,
      reloadCommits,
      offerSignIn,
    ],
  );

  // The push a sign-in resumed (#325), sent as the server named it: no second commit, bound
  // to the approved destination. A second refusal is not offered again.
  const runResumedPush = useCallback(
    async (resume: GitRunStackedActionInput, onPushed?: () => void) => {
      const toastId = toastManager.add({
        type: "loading",
        title: "Pushing…",
        timeout: 0,
        data: threadToastData,
      });
      const push = trackPushPhase(toastId, threadToastData);
      // This panel sends commit, push and commit-and-push only, so the resume is a `push`.
      const result = await runAction.run({
        actionId: randomUUID(),
        action: resume.action,
        ...(resume.expectedDestination === undefined
          ? {}
          : { expectedDestination: resume.expectedDestination }),
        onProgress: push.onProgress,
        signal: push.signal,
      });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) {
          closeOrReportCancelledPush(toastId, push.signal, threadToastData);
          return;
        }
        const error = squashAtomCommandFailure(result);
        toastManager.update(
          toastId,
          stackedThreadToast({
            type: "error",
            title: stackedActionFailureTitle(error),
            description:
              push.failure()?.signIn !== undefined
                ? SIGN_IN_REPEATED_MESSAGE
                : sourceControlErrorMessage(error),
            data: threadToastData,
          }),
        );
        return;
      }
      reloadCommits();
      toastManager.update(toastId, {
        type: "success",
        title: result.value.toast.title,
        description: result.value.toast.description,
        timeout: 0,
        data: { ...threadToastData, dismissAfterVisibleMs: 10_000 },
      });
      onPushed?.();
    },
    [reloadCommits, runAction, threadToastData],
  );
  useEffect(() => {
    runResumedPushRef.current = runResumedPush;
  }, [runResumedPush]);

  const runPull = useCallback(
    async (resume?: VcsPullInput) => {
      const controller = new AbortController();
      const toastId = toastManager.add({
        type: "loading",
        title: "Pulling…",
        timeout: 0,
        data: threadToastData,
        actionProps: { children: "Cancel", onClick: () => controller.abort() },
      });
      const result = await pullAction.run({
        ...(resume?.expectedDestination === undefined
          ? {}
          : { expectedDestination: resume.expectedDestination }),
        signal: controller.signal,
      });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) {
          if (controller.signal.aborted) {
            toastManager.update(toastId, {
              type: "info",
              title: "Pull cancelled",
              description: "Nothing was pulled.",
              data: threadToastData,
            });
          } else {
            toastManager.close(toastId);
          }
          return;
        }
        const error = squashAtomCommandFailure(result);
        if (isSignInRequired(error) && gitCwd !== null) {
          toastManager.close(toastId);
          const pullFailed = (message: string) =>
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Pull failed",
                description: message,
                data: threadToastData,
              }),
            );
          if (resume !== undefined) {
            pullFailed(SIGN_IN_REPEATED_MESSAGE);
            return;
          }
          offerSignIn({
            offer: error,
            cwd: gitCwd,
            onSignedIn: () => void runPullRef.current?.(error.resume),
            onEnded: (_code, message) => pullFailed(message),
          });
          return;
        }
        toastManager.update(
          toastId,
          stackedThreadToast({
            type: "error",
            title: "Pull failed",
            description: sourceControlErrorMessage(error),
            data: threadToastData,
          }),
        );
        return;
      }
      toastManager.update(toastId, {
        type: "success",
        title: result.value.status === "pulled" ? "Pulled" : "Already up to date",
        timeout: 0,
        data: threadToastData,
      });
    },
    [gitCwd, pullAction, offerSignIn, threadToastData],
  );
  useEffect(() => {
    runPullRef.current = runPull;
  }, [runPull]);

  const surfaceFileActionFailure = useCallback(
    (result: Awaited<ReturnType<typeof stageAction.run>>, title: string) => {
      if (result._tag !== "Failure") return true;
      if (isAtomCommandInterrupted(result)) return false;
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title,
          description: sourceControlErrorMessage(error),
          data: threadToastData,
        }),
      );
      return false;
    },
    [threadToastData],
  );

  const runStage = useCallback(
    async (filePaths: string[]) => {
      return surfaceFileActionFailure(await stageAction.run(filePaths), "Could not stage files");
    },
    [stageAction, surfaceFileActionFailure],
  );

  const runUnstage = useCallback(
    async (filePaths: string[]) => {
      return surfaceFileActionFailure(
        await unstageAction.run(filePaths),
        "Could not unstage files",
      );
    },
    [unstageAction, surfaceFileActionFailure],
  );

  const runDiscard = useCallback(
    async (filePaths: readonly string[]) => {
      return surfaceFileActionFailure(
        await discardAction.run([...filePaths]),
        "Could not discard files",
      );
    },
    [discardAction, surfaceFileActionFailure],
  );

  const stagedPathsForDiscard = useCallback(
    (pending: PendingDiscard): string[] => {
      if (pending.kind === "entry") {
        return pending.file.area === "staged" ? [pending.file.path] : [];
      }
      const pendingPaths = new Set(pending.paths);
      return files
        .filter((file) => file.area === "staged" && pendingPaths.has(file.path))
        .map((file) => file.path);
    },
    [files],
  );

  const runConfirmedDiscard = useCallback(
    async (pending: PendingDiscard): Promise<boolean> => {
      const paths = discardPathsOf(pending);
      if (paths.length === 0) return false;
      const stagedPaths = stagedPathsForDiscard(pending);
      if (stagedPaths.length > 0 && !(await runUnstage(stagedPaths))) return false;
      return runDiscard(paths);
    },
    [runDiscard, runUnstage, stagedPathsForDiscard],
  );

  const toggleSelectedFile = useCallback((path: string, selected: boolean) => {
    if (ignoreMutationRef.current) return;
    setSelectedFilePaths((current) => {
      const next = new Set(current);
      if (selected) {
        next.add(path);
      } else {
        next.delete(path);
      }
      return next;
    });
  }, []);

  const enterSelectionMode = useCallback(() => {
    if (ignoreMutationRef.current) return;
    selectionSessionRef.current += 1;
    setSelectedFilePaths(new Set<string>());
    setRestoreSelectFocus(false);
    setSelectionMode(true);
  }, []);

  const exitSelectionMode = useCallback(() => {
    selectionSessionRef.current += 1;
    setSelectedFilePaths(new Set<string>());
    setSelectionMode(false);
    setRestoreSelectFocus(true);
  }, []);

  const setFilesSelected = useCallback(
    (sectionFiles: readonly WorkingTreeFile[], selected: boolean) => {
      if (ignoreMutationRef.current) return;
      setSelectedFilePaths((current) => {
        const next = new Set(current);
        for (const file of sectionFiles) {
          if (selected) next.add(file.path);
          else next.delete(file.path);
        }
        return next;
      });
    },
    [],
  );

  const runIgnorePatterns = useCallback(
    async (patterns: readonly string[], pathsToDiscard: readonly string[]): Promise<boolean> => {
      if (!gitCwd || patterns.length === 0 || ignoreMutationRef.current) return false;
      const mutation = Symbol();
      ignoreMutationRef.current = mutation;
      setIgnorePending(true);
      const updateGitignore = async (): Promise<boolean> => {
        const uniquePatterns = Array.from(new Set(patterns));
        const readResult = await readProjectFile({
          environmentId,
          input: { cwd: gitCwd, relativePath: ".gitignore" },
        });
        if (isAtomCommandInterrupted(readResult)) return false;
        const currentContents = readResult._tag === "Success" ? readResult.value.contents : "";
        const nextContents = uniquePatterns.reduce(
          (contents, pattern) => appendGitignorePattern(contents, pattern),
          currentContents,
        );
        const writeResult = await writeProjectFile({
          environmentId,
          input: { cwd: gitCwd, relativePath: ".gitignore", contents: nextContents },
        });
        if (writeResult._tag === "Failure") {
          if (isAtomCommandInterrupted(writeResult)) return false;
          const error = squashAtomCommandFailure(writeResult);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not update .gitignore",
              description: sourceControlErrorMessage(error),
              data: threadToastData,
            }),
          );
          return false;
        }
        if (pathsToDiscard.length > 0 && !(await runDiscard(pathsToDiscard))) {
          return false;
        }
        return true;
      };
      return updateGitignore().finally(() => {
        if (ignoreMutationRef.current === mutation) {
          ignoreMutationRef.current = null;
          setIgnorePending(false);
        }
      });
    },
    [environmentId, gitCwd, readProjectFile, runDiscard, threadToastData, writeProjectFile],
  );

  const onIgnoreFileName = useCallback(
    (path: string) => {
      void runIgnorePatterns([ignoreFileNamePattern(path)], [path]);
    },
    [runIgnorePatterns],
  );

  const onIgnoreParentFolder = useCallback(
    (path: string) => {
      const pattern = ignoreParentFolderPattern(path);
      if (!pattern) return;
      void runIgnorePatterns([pattern], [path]);
    },
    [runIgnorePatterns],
  );

  // Per-file checkbox toggle (VS Code-style staging): resolve stage vs.
  // unstage from the file's actual area, then reuse the same per-panel
  // action hooks (busy-disable + failure toasts) as the bulk section buttons.
  const onToggleFile = useCallback(
    (path: string) => {
      const file = files.find((candidate) => candidate.path === path);
      if (resolveStagingToggleAction(file?.area) === "unstage") {
        void runUnstage([path]);
      } else {
        void runStage([path]);
      }
    },
    [files, runStage, runUnstage],
  );

  const onGenerate = useCallback(async () => {
    const token = generationTokenRef.current + 1;
    generationTokenRef.current = token;
    const result = await generateAction.run({ filePaths: generateFilePaths });
    if (generationTokenRef.current !== token) return; // canceled/superseded
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not generate a commit message",
          description: sourceControlErrorMessage(error),
          data: threadToastData,
        }),
      );
      return;
    }
    if (result.value.message.trim().length > 0) {
      setDraftMessage(result.value.message);
    }
  }, [generateAction, generateFilePaths, setDraftMessage, threadToastData]);

  const cancelGenerate = useCallback(() => {
    // There is no clean client-side interrupt path for this RPC: unlike
    // thread turns (which have a dedicated `thread.turn.interrupt` command
    // the server honors), `vcs.generateCommitMessage` is a plain unary RPC
    // run through createEnvironmentRpcCommand -> Effect.runPromiseExit, which
    // doesn't expose a Fiber/AbortSignal handle back to the caller, and no
    // interrupt RPC exists for it in the contract. So stop = ignore result;
    // the RPC keeps running and completes server-side.
    generationTokenRef.current += 1;
  }, []);

  const openPr = useCallback(() => {
    const api = readLocalApi();
    const prUrl = status?.pr?.state === "open" ? status.pr.url : null;
    if (!api || !prUrl) return;
    void openPullRequestLink(api.shell, prUrl);
  }, [status]);

  const openPrInPanel = useCallback(() => {
    const pr = status?.pr?.state === "open" ? status.pr : null;
    if (!pr) return;
    useRightPanelStore.getState().openPullRequest(threadRef, {
      number: pr.number,
      provider: status?.sourceControlProvider?.kind ?? "unknown",
    });
  }, [status, threadRef]);

  const onPrimaryAction = useCallback(() => {
    if (quickAction.kind === "open_pr") return openPr();
    if (quickAction.kind === "run_pull") return void runPull();
    if (quickAction.kind === "run_action" && quickAction.action) {
      return void runGitAction(quickAction.action);
    }
    // open_publish / show_hint: no-op here (surfaced as disabled below).
  }, [openPr, quickAction, runGitAction, runPull]);

  // Commit-first ladder dispatch (staging-area servers). Commit-family actions
  // route through runGitAction, which holds the ledger guard (commit the staged
  // index as-is via commitStagedIndexAsIs, never filePaths) and the
  // default-branch confirm dialog.
  const onScPrimaryAction = useCallback(() => {
    switch (primaryAction.kind) {
      case "commit":
      case "push":
      case "create_pr":
        if (primaryAction.stackedAction) void runGitAction(primaryAction.stackedAction);
        return;
      case "stage_all":
        void runStage([...groups.unstaged, ...groups.untracked].map((file) => file.path));
        return;
      case "pull":
        void runPull();
        return;
      case "open_pr":
        openPr();
        return;
      // publish / sync_hint / none: disabled below, no-op here.
    }
  }, [primaryAction, runGitAction, runStage, runPull, openPr, groups]);

  const onScMenuItem = useCallback(
    (item: SourceControlMenuItem) => {
      switch (item.kind) {
        case "run_stacked":
          if (item.stackedAction) void runGitAction(item.stackedAction);
          return;
        case "run_pull":
          void runPull();
          return;
        case "open_pr":
          openPr();
          return;
        case "open_pr_panel":
          openPrInPanel();
          return;
        case "open_publish":
          // The publish wizard lives in the (frozen) chat-header GitActionsControl;
          // the panel renders this item disabled and no-ops here.
          return;
        case "open_merge":
          setMergeDialogOpen(true);
          return;
      }
    },
    [openPr, openPrInPanel, runGitAction, runPull],
  );

  const onRequestDiscardFile = useCallback((file: WorkingTreeFile) => {
    setPendingDiscard({ kind: "entry", file });
  }, []);

  const onCopyPath = useCallback(
    (path: string, relative: boolean) => {
      // Copy Path yields the absolute path (root joined with the native
      // separator); Copy Relative Path yields the tree-relative path as-is.
      // Without a known root an absolute path can't be built, so fall back to
      // the relative path.
      const text = relative || gitCwd === null ? path : joinWorkspacePath(gitCwd, path);
      void navigator.clipboard.writeText(text);
    },
    [gitCwd],
  );

  const onOpenExternalEditor = useCallback(
    (path: string) => {
      if (!preferredEditor || gitCwd === null) return;
      // openInEditor opens the given path in the editor (mirrors FileBrowserPanel):
      // a file path opens that file, a directory opens the folder.
      void openInEditor({
        environmentId,
        input: { cwd: joinWorkspacePath(gitCwd, path), editor: preferredEditor },
      });
    },
    [environmentId, gitCwd, openInEditor, preferredEditor],
  );

  const openFileInDiff = useCallback(
    (_path: string, area?: VcsStagingArea) => {
      useRightPanelStore.getState().open(threadRef, "diff");
      // The "unstaged" scope is a worktree-vs-index diff, which is empty for a
      // fully staged file — so staged rows open the "branch" scope (branch-vs-base
      // includes the staged changes) while unstaged/untracked keep the worktree
      // scope. FOLLOW-UP: a dedicated staged-vs-HEAD (git diff --cached) diff
      // source would show a staged row's exact staged hunks (see scc-progress.md).
      useDiffPanelStore
        .getState()
        .selectGitScope(threadRef, area === "staged" ? "branch" : "unstaged");
    },
    [threadRef],
  );

  const header = (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <span className="truncate text-sm font-medium">{status?.refName ?? "Source Control"}</span>
      {vsBaseLabel ? (
        <span className="shrink-0 text-xs text-muted-foreground">{vsBaseLabel}</span>
      ) : null}
      {status?.pr?.state === "open" ? (
        <button
          type="button"
          onClick={openPr}
          className="shrink-0 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
        >
          {terminology.shortLabel} #{status.pr.number}
        </button>
      ) : null}
      {status && (status.aheadCount > 0 || status.behindCount > 0) ? (
        <span className="shrink-0 text-xs text-muted-foreground">
          {status.aheadCount > 0 ? `↑${status.aheadCount}` : ""}{" "}
          {status.behindCount > 0 ? `↓${status.behindCount}` : ""}
        </span>
      ) : null}
      {codeReview ? (
        <Tooltip>
          {/* Stays focusable while disabled, so its tooltip can say why. */}
          <TooltipTrigger
            render={
              <Button
                aria-disabled={codeReviewButton.disabled}
                aria-label="Review changes"
                className={cn("ml-auto shrink-0", codeReviewButton.disabled && "opacity-64")}
                size="icon-xs"
                variant="ghost"
                onClick={() => {
                  if (!codeReviewButton.disabled && codeReviewScope) {
                    codeReview.onStart(codeReviewScope);
                  }
                }}
              />
            }
          >
            <ScanSearchIcon aria-hidden="true" className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {codeReviewButton.reason ?? (
              <>
                <span className="block">
                  {codeReviewScope ? codeReviewTooltip(codeReviewScope) : "Review changes"}
                </span>
                {codeReview.guardLine ? (
                  <span className="block text-muted-foreground">{codeReview.guardLine}</span>
                ) : null}
              </>
            )}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {codeReview ? (
        <Menu>
          <MenuTrigger
            render={<Button aria-label="Review options" size="icon-xs" variant="ghost" />}
          >
            <ChevronDownIcon aria-hidden="true" className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem
              disabled={codeReviewButton.disabled}
              onClick={() => {
                if (!codeReviewButton.disabled) setReviewInstructionsOpen(true);
              }}
            >
              <span className="flex flex-col">
                <span>Review with instructions…</span>
                {codeReviewButton.reason ? (
                  <span className="text-xs text-muted-foreground">{codeReviewButton.reason}</span>
                ) : null}
              </span>
            </MenuItem>
            {codeReviewMenuItems.length > 0 ? <MenuSeparator /> : null}
            {codeReviewMenuItems.length > 0 ? (
              <MenuGroup>
                <MenuGroupLabel>Review once with</MenuGroupLabel>
                {codeReviewMenuItems.map(({ reviewer, state }) => (
                  <MenuItem
                    key={reviewer.value}
                    disabled={state.disabled}
                    onClick={() => {
                      if (!state.disabled && codeReviewScope) {
                        codeReview.onStart(codeReviewScope, reviewer.selection);
                      }
                    }}
                  >
                    <span className="flex flex-col">
                      <span>{reviewer.label}</span>
                      {/* A disabled reviewer says why in place of its guard line. */}
                      <span className="text-xs text-muted-foreground">
                        {state.reason ?? reviewer.guardLine}
                      </span>
                    </span>
                  </MenuItem>
                ))}
              </MenuGroup>
            ) : null}
            {codeReview.projectId ? (
              <>
                <MenuSeparator />
                <MenuItem
                  disabled={!codeReviewsSupported}
                  {...(codeReviewsSupported ? {} : { title: CODE_REVIEW_SERVER_UPDATE_REASON })}
                  onClick={() => setReviewPromptDialogOpen(true)}
                >
                  Review prompt for this project…
                </MenuItem>
              </>
            ) : null}
          </MenuPopup>
        </Menu>
      ) : null}
    </div>
  );

  const requiresStaged =
    quickAction.kind === "run_action" && quickAction.action?.startsWith("commit") === true;
  // Real staging server gates commit on the staged set; a legacy server (no
  // areas) gates on there being any changes at all.
  const commitGateUnmet = hasAreas
    ? files.length > 0 && groups.staged.length === 0
    : files.length === 0;
  const primaryDisabled =
    isBusy ||
    quickAction.disabled ||
    quickAction.kind === "open_publish" ||
    (requiresStaged && commitGateUnmet);
  const pendingConfirmCopy = pendingConfirm
    ? resolveDefaultBranchActionDialogCopy({
        action: pendingConfirm.action,
        branchName: pendingConfirm.branchName,
        includesCommit: pendingConfirm.includesCommit,
        terminology,
      })
    : null;
  const pendingDiscardCopy = pendingDiscard ? resolveDiscardDialogCopy(pendingDiscard) : null;

  // The resolver already returns disabled when busy / diverged / up-to-date;
  // publish has no wired flow in the panel so it's disabled too.
  const scPrimaryDisabled = primaryAction.disabled || primaryAction.kind === "publish";
  const scPrimaryLabel =
    primaryAction.count !== undefined
      ? `${primaryAction.label} (${primaryAction.count})`
      : primaryAction.label;

  // Per-row affordances shared by the staging-area sections. getRowActions
  // gates which inline buttons render per area, so passing the full set to every
  // section is safe (e.g. onUnstageFile is a no-op for an unstaged row).
  // Folder headers act on a whole folder in one request instead of one per file.
  const folderActionProps = {
    onStageFiles: (paths: readonly string[]) => void runStage([...paths]),
    onUnstageFiles: (paths: readonly string[]) => void runUnstage([...paths]),
    onSelectFiles: setFilesSelected,
  };

  const rowActionProps = {
    onStageFile: (path: string) => void runStage([path]),
    onUnstageFile: (path: string) => void runUnstage([path]),
    onRequestDiscardFile,
    onIgnoreFileName,
    onIgnoreParentFolder,
    onCopyPath,
    onOpenExternalEditor,
    isPrimaryEnv,
  };

  // What the Staged Changes, Changes and Untracked Files sections share.
  const stagingSectionProps = {
    checked: isFileStaged,
    onToggle: onToggleFile,
    onOpenFile: openFileInDiff,
    disabled: isBusy || ignorePending,
    ...rowActionProps,
    ...folderActionProps,
    selectionMode: activeSelectionMode,
    selected: (file: WorkingTreeFile) => selectedFilePaths.has(file.path),
    onSelect: toggleSelectedFile,
  };

  if (workspaceUnavailable) {
    return (
      <DiffPanelShell mode={mode} header={header}>
        <div
          role="alert"
          className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground"
        >
          {workspaceUnavailable}
        </div>
      </DiffPanelShell>
    );
  }

  return (
    <DiffPanelShell mode={mode} header={header}>
      <div
        className="flex min-h-0 flex-1 flex-col gap-2 p-2"
        onKeyDown={(event) => {
          if (!activeSelectionMode || event.key !== "Escape" || ignoreMutationRef.current) return;
          event.preventDefault();
          exitSelectionMode();
        }}
      >
        {signIn.state === null ? null : (
          <GitSignInPrompt
            offer={signIn.state.offer}
            phase={signIn.state.phase}
            onCancel={signIn.cancel}
            onNotNow={signIn.decline}
            onSignIn={signIn.approve}
          />
        )}
        <div className="relative">
          <Textarea
            value={draft.message}
            onChange={(event) => draft.setMessage(event.target.value)}
            placeholder="Message (leave empty to auto-generate)"
            size="sm"
            aria-label="Commit message"
            className="pr-9"
          />
          <button
            type="button"
            onClick={() => (generateAction.isPending ? cancelGenerate() : void onGenerate())}
            disabled={files.length === 0 && !generateAction.isPending}
            aria-label={
              generateAction.isPending ? "Stop generating" : "Generate commit message with AI"
            }
            title={generateAction.isPending ? "Stop" : "Generate commit message with AI"}
            className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
          >
            {generateAction.isPending ? (
              <SquareIcon className="size-3.5" />
            ) : (
              <SparklesIcon className="size-3.5" />
            )}
          </button>
        </div>
        {gitCwd === null ? null : (
          <SourceControlDraftConflict environmentId={environmentId} cwd={gitCwd} />
        )}
        <SourceControlAgentSuggestion
          environmentId={environmentId}
          cwd={gitCwd}
          legacyThreadKey={scopedThreadKey(threadRef)}
          draftMessage={draft.message}
        />

        <div className="flex items-center gap-1">
          {activeSelectionMode ? (
            <>
              <Button
                autoFocus
                size="sm"
                variant="outline"
                disabled={isBusy || ignorePending}
                onClick={() => {
                  if (!ignoreMutationRef.current) exitSelectionMode();
                }}
              >
                Cancel
              </Button>
              <span className="mr-auto text-xs text-muted-foreground" aria-live="polite">
                {selectedPaths.length} {selectedPaths.length === 1 ? "file" : "files"} selected
              </span>
              <Button
                size="sm"
                variant="outline"
                aria-label={
                  selectedAllUntracked ? "Delete selected files" : "Discard selected files"
                }
                disabled={isBusy || ignorePending || selectedPaths.length === 0}
                onClick={() => {
                  if (ignoreMutationRef.current) return;
                  setPendingDiscard({
                    kind: "bulk",
                    paths: selectedPaths,
                    variant: selectedAllUntracked ? "delete-untracked" : "discard",
                  });
                }}
              >
                {selectedAllUntracked ? "Delete" : "Discard"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                aria-label="Ignore selected files"
                disabled={isBusy || ignorePending || selectedPaths.length === 0}
                onClick={() => {
                  if (ignoreMutationRef.current) return;
                  const selectionSession = selectionSessionRef.current;
                  void runIgnorePatterns(
                    selectedPaths.map(ignoreFileNamePattern),
                    selectedPaths,
                  ).then((succeeded) => {
                    if (succeeded && selectionSessionRef.current === selectionSession) {
                      exitSelectionMode();
                    }
                  });
                }}
              >
                Ignore
              </Button>
            </>
          ) : (
            <>
              {hasAreas && files.length > 0 ? (
                <Button
                  autoFocus={restoreSelectFocus}
                  size="sm"
                  variant="outline"
                  disabled={isBusy || ignorePending}
                  onClick={enterSelectionMode}
                >
                  <ListChecksIcon className="size-3.5" aria-hidden />
                  Select
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                disabled={isBusy || ignorePending || files.length === 0}
                onClick={() => {
                  if (ignoreMutationRef.current) return;
                  setPendingDiscard({
                    kind: "bulk",
                    paths: files.map((file) => file.path),
                    variant: "discard",
                  });
                }}
              >
                <Undo2Icon className="size-3.5" aria-hidden />
                Discard All
              </Button>
              {hasAreas && mergeInProgress ? null : hasAreas ? (
                <>
                  <Button
                    className="flex-1"
                    size="sm"
                    disabled={scPrimaryDisabled}
                    onClick={onScPrimaryAction}
                    {...(primaryAction.hint ? { title: primaryAction.hint } : {})}
                  >
                    {isBusy ? <Spinner className="size-3.5" aria-hidden /> : null}
                    {scPrimaryLabel}
                  </Button>
                  <Menu>
                    <MenuTrigger
                      render={
                        <Button
                          aria-label="Source control actions"
                          size="icon-xs"
                          variant="outline"
                        />
                      }
                      disabled={isBusy}
                    >
                      <ChevronDownIcon className="size-4" aria-hidden />
                    </MenuTrigger>
                    <MenuPopup align="end">
                      {scMenuItems.map((item, index) => (
                        <Fragment key={item.id}>
                          {index > 0 && scMenuItems[index - 1]?.group !== item.group ? (
                            <MenuSeparator />
                          ) : null}
                          <MenuItem
                            disabled={item.disabled}
                            {...(item.reason ? { title: item.reason } : {})}
                            onClick={() => onScMenuItem(item)}
                          >
                            {item.group === "commit" ? (
                              <GitCommitIcon />
                            ) : item.id === "pull" ? (
                              <DownloadIcon />
                            ) : item.id === "push" || item.id === "publish" ? (
                              <CloudUploadIcon />
                            ) : presentation.showProviderIcon ? (
                              <presentation.Icon />
                            ) : null}
                            {item.label}
                          </MenuItem>
                        </Fragment>
                      ))}
                    </MenuPopup>
                  </Menu>
                </>
              ) : (
                <>
                  <Button
                    className="flex-1"
                    size="sm"
                    disabled={primaryDisabled}
                    onClick={onPrimaryAction}
                  >
                    {isBusy ? <Spinner className="size-3.5" aria-hidden /> : null}
                    {quickAction.label}
                  </Button>
                  <Menu>
                    <MenuTrigger
                      render={
                        <Button
                          aria-label="Source control actions"
                          size="icon-xs"
                          variant="outline"
                        />
                      }
                      disabled={isBusy}
                    >
                      <ChevronDownIcon className="size-4" aria-hidden />
                    </MenuTrigger>
                    <MenuPopup align="end">
                      {menuItems.map((item) => (
                        <MenuItem
                          key={item.id}
                          disabled={
                            item.disabled ||
                            (item.dialogAction === "commit" &&
                              (hasAreas ? groups.staged.length === 0 : files.length === 0))
                          }
                          onClick={() => {
                            if (item.kind === "open_pr_panel") return openPrInPanel();
                            if (item.kind === "open_pr") return openPr();
                            if (item.dialogAction) return void runGitAction(item.dialogAction);
                          }}
                        >
                          {item.icon === "commit" ? (
                            <GitCommitIcon />
                          ) : item.icon === "push" ? (
                            <CloudUploadIcon />
                          ) : presentation.showProviderIcon ? (
                            <presentation.Icon />
                          ) : null}
                          {item.label}
                        </MenuItem>
                      ))}
                    </MenuPopup>
                  </Menu>
                </>
              )}
            </>
          )}
          {files.length > 0 ? (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Group by folder"
              aria-pressed={groupByFolder}
              title={
                groupByFolder ? "Grouped by folder: show a flat list" : "Flat list: group by folder"
              }
              onClick={() => setGroupByFolder(!groupByFolder)}
              className={cn(groupByFolder && "bg-accent text-foreground")}
            >
              {groupByFolder ? (
                <FolderTreeIcon className="size-3.5" />
              ) : (
                <ListIcon className="size-3.5" />
              )}
            </Button>
          ) : null}
        </div>

        {mergeRecoveryShown && recoveryScope !== null ? (
          <div className="overflow-hidden rounded-md border border-border/60">
            <GitManagerOperationBanner operation={recoveryEvent} onCancel={cancelRecovery} />
            <GitManagerInProgressStrip
              blocked={null}
              continueDisabledReason={
                groups.conflicted.length > 0
                  ? "Resolve and stage every conflicted file first."
                  : null
              }
              continueLabel="Commit merge"
              disabledReason={stripDisabledReason}
              operation={MERGE_IN_PROGRESS}
              onAbort={() => runRecovery({ _tag: "abort", ...recoveryScope, operation: "merge" })}
              onContinue={() =>
                runRecovery({ _tag: "continue", ...recoveryScope, operation: "merge" })
              }
            />
            {groups.conflicted.length > 0 ? (
              <SourceControlMergeChanges
                disabled={isBusy || !mergeAvailable}
                files={groups.conflicted}
                onMarkResolved={(path) => void runStage([path])}
                openInEditorDisabledReason={
                  preferredEditor
                    ? null
                    : "No external editor is available. Install one, or open the file from Files."
                }
                onOpenInEditor={onOpenExternalEditor}
                onResolve={(path, side) =>
                  runRecovery({ _tag: "resolve-conflict", ...recoveryScope, path, side })
                }
              />
            ) : null}
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-border/60">
          {statusQuery.isPending && !status ? (
            <p className="flex items-center gap-2 px-3 py-6 text-xs text-muted-foreground">
              <Spinner className="size-3.5" aria-hidden /> Loading changes…
            </p>
          ) : files.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">No changes</p>
          ) : !hasAreas ? (
            // Legacy server (no staging areas): one flat list of all changes.
            // No stage/unstage RPCs exist here, so no per-row checkbox renders.
            <SourceControlChangesList
              groupByFolder={groupByFolder}
              sections={[
                {
                  title: "Changes",
                  files,
                  onToggle: LEGACY_NOOP_TOGGLE,
                  onOpenFile: openFileInDiff,
                  disabled: isBusy,
                },
              ]}
            />
          ) : (
            <SourceControlChangesList
              groupByFolder={groupByFolder}
              sections={[
                {
                  ...stagingSectionProps,
                  title: "Staged Changes",
                  files: groups.staged,
                  primaryAction: {
                    icon: "unstage",
                    label: "Unstage all",
                    onClick: () => void runUnstage(groups.staged.map((file) => file.path)),
                  },
                  allSelected: groups.staged.every((file) => selectedFilePaths.has(file.path)),
                  onSelectAll: (selected) => setFilesSelected(groups.staged, selected),
                },
                {
                  ...stagingSectionProps,
                  title: "Changes",
                  files: groups.unstaged,
                  primaryAction: {
                    icon: "stage",
                    label: "Stage all",
                    onClick: () => void runStage(groups.unstaged.map((file) => file.path)),
                  },
                  onDiscard: () =>
                    setPendingDiscard({
                      kind: "bulk",
                      paths: groups.unstaged.map((file) => file.path),
                      variant: "discard",
                    }),
                  allSelected: groups.unstaged.every((file) => selectedFilePaths.has(file.path)),
                  onSelectAll: (selected) => setFilesSelected(groups.unstaged, selected),
                },
                {
                  ...stagingSectionProps,
                  title: "Untracked Files",
                  files: groups.untracked,
                  primaryAction: {
                    icon: "stage",
                    label: "Stage all",
                    onClick: () => void runStage(groups.untracked.map((file) => file.path)),
                  },
                  onDiscard: () =>
                    setPendingDiscard({
                      kind: "bulk",
                      paths: groups.untracked.map((file) => file.path),
                      variant: "delete-untracked",
                    }),
                  discardVariant: "delete-untracked",
                  allSelected: groups.untracked.every((file) => selectedFilePaths.has(file.path)),
                  onSelectAll: (selected) => setFilesSelected(groups.untracked, selected),
                },
              ]}
            />
          )}
        </div>

        {summary.totalCount > 0 ? (
          <div className={cn("flex justify-end px-1 font-mono text-xs")}>
            <span className="text-success">+{summary.insertions}</span>
            <span className="text-muted-foreground"> / </span>
            <span className="text-destructive">-{summary.deletions}</span>
          </div>
        ) : null}
      </div>

      {codeReview ? (
        <CodeReviewInstructionsDialog
          open={reviewInstructionsOpen}
          onOpenChange={setReviewInstructionsOpen}
          onStart={(instructions) => {
            // The scope at Start, as the button reads it at its click.
            if (!codeReviewButton.disabled && codeReviewScope) {
              codeReview.onStart(codeReviewScope, undefined, instructions);
            }
          }}
        />
      ) : null}
      {codeReview?.projectId ? (
        <CodeReviewProjectPromptDialog
          open={reviewPromptDialogOpen}
          onOpenChange={setReviewPromptDialogOpen}
          environmentId={environmentId}
          projectId={codeReview.projectId}
          projectPrompt={codeReview.projectPrompt}
          userPrompt={codeReview.userPrompt}
        />
      ) : null}

      {pendingPullRequest !== null &&
      pendingPullRequest.scope.environmentId === environmentId &&
      pendingPullRequest.scope.cwd === gitCwd ? (
        <GitManagerCreatePullRequestDialog
          open
          scope={pendingPullRequest.scope}
          {...(pendingPullRequest.commitInput
            ? { commitInput: pendingPullRequest.commitInput }
            : {})}
          onOpenChange={(open) => {
            if (!open) setPendingPullRequest(null);
          }}
          onSettled={(result) => {
            // Clear only the text this commit sent; with none sent, a draft typed since stays.
            const submitted = pendingPullRequest.commitInput?.commitMessage;
            if (result.commit.status === "created" && submitted !== undefined) {
              draft.clear(submitted);
            }
            reloadCommits();
          }}
          onDone={(request) => {
            if (
              canOpenPullRequestInPanel({
                enabled: pullRequestsEnabled,
                providerKind: request.provider,
              })
            )
              useRightPanelStore.getState().openPullRequest(threadRef, request);
          }}
        />
      ) : null}
      {projectRef !== null && gitCwd !== null ? (
        <GitManagerMergeDialog
          open={mergeDialogOpen}
          projectRef={projectRef}
          refs={refsQuery.data?.localBranches ?? EMPTY_REFS}
          remoteRefs={refsQuery.data?.remoteBranches ?? EMPTY_REFS}
          remotes={refsQuery.data?.remotes ?? EMPTY_REMOTES}
          refsError={refsQuery.error}
          scope={{ environmentId, cwd: gitCwd }}
          targetMode="current-branch"
          onFinished={reloadCommits}
          onOpenChange={setMergeDialogOpen}
          onRefsStale={refsQuery.refresh}
          onRunningChange={setMergeOperationRunning}
        />
      ) : null}
      <Dialog
        open={pendingConfirm !== null}
        onOpenChange={(open) => !open && setPendingConfirm(null)}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {pendingConfirmCopy?.title ?? "Run action on default branch?"}
            </DialogTitle>
            <DialogDescription>{pendingConfirmCopy?.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setPendingConfirm(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => {
                const action = pendingConfirm?.action;
                setPendingConfirm(null);
                if (action) void runGitAction(action, { skipConfirm: true });
              }}
            >
              {pendingConfirmCopy?.continueLabel ?? "Continue"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={pendingDiscard !== null}
        onOpenChange={(open) => !open && setPendingDiscard(null)}
      >
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>{pendingDiscardCopy?.title ?? "Discard changes?"}</DialogTitle>
            <DialogDescription>{pendingDiscardCopy?.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setPendingDiscard(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              {...(pendingDiscardCopy?.destructive ? { variant: "destructive" as const } : {})}
              onClick={() => {
                const pending = pendingDiscard;
                const exitAfterSuccess = activeSelectionMode;
                setPendingDiscard(null);
                if (!pending) return;
                void runConfirmedDiscard(pending).then((succeeded) => {
                  if (succeeded && exitAfterSuccess) exitSelectionMode();
                });
              }}
            >
              {pendingDiscardCopy?.confirmLabel ?? "Discard"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <SourceControlCommits
        threadRef={threadRef}
        gitCwd={gitCwd}
        nowMs={commitReload.nowMs}
        reloadToken={commitReload.signal}
      />
    </DiffPanelShell>
  );
}

/**
 * Follows a stacked action's progress for its toast (#325): Cancel appears only while the push
 * runs (commit and branch are local and short), and the terminal failure's phase and sign-in
 * offer are kept, since the settled error carries neither.
 */
function trackPushPhase(toastId: string, data: ThreadToastData) {
  const controller = new AbortController();
  let failed: Extract<GitActionProgressEvent, { kind: "action_failed" }> | null = null;
  return {
    signal: controller.signal,
    failure: () => failed,
    onProgress: (event: GitActionProgressEvent) => {
      if (event.kind === "phase_started") {
        toastManager.update(toastId, {
          type: "loading",
          title: event.label,
          timeout: 0,
          data,
          ...(event.phase === "push"
            ? { actionProps: { children: "Cancel", onClick: () => controller.abort() } }
            : {}),
        });
      } else if (event.kind === "action_failed") {
        failed = event;
      }
    },
  };
}

const isSignInRequired = Schema.is(GitSignInRequiredError);

function closeOrReportCancelledPush(toastId: string, signal: AbortSignal, data: ThreadToastData) {
  if (!signal.aborted) {
    toastManager.close(toastId);
    return;
  }
  toastManager.update(toastId, {
    type: "info",
    title: "Push cancelled",
    description: "Your commit is saved locally.",
    data,
  });
}
