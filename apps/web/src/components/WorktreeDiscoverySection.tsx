import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  type EnvironmentId,
  type ScopedThreadRef,
  type ServerConfig,
  type VcsWorktreeDescriptor,
  type WorktreeAdoptInput,
} from "@bibcode/contracts";
import { scopeThreadRef } from "@bibcode/client-runtime/environment";
import {
  deriveWorktreeDiscoveryState,
  isWorktreeCatalogSupported,
} from "@bibcode/client-runtime/state/worktrees";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@bibcode/client-runtime/state/runtime";
import {
  ChevronRightIcon,
  CloudIcon,
  EyeOffIcon,
  FolderSearchIcon,
  LoaderIcon,
  MonitorIcon,
  PlusIcon,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { newCommandId } from "../lib/utils";
import { resolveProviderSessionSelectionForInstance } from "../providerSessionSelection";
import type { SidebarProjectGroupMember, SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { useWorktreeCatalogFocusRefresh, worktreeEnvironment } from "../state/worktrees";
import {
  buildWorktreeDiscoveryGroups,
  formatDiscoveredWorktreeCount,
  formatWorktreeAddAllSummary,
} from "./WorktreeDiscoverySection.logic";
import { Button } from "./ui/button";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export interface WorktreeDiscoverySectionProps {
  readonly project: SidebarProjectSnapshot;
  readonly serverConfigs: ReadonlyMap<EnvironmentId, ServerConfig>;
  readonly primaryEnvironmentId?: EnvironmentId | null;
  readonly onNavigateToThread: (threadRef: ScopedThreadRef) => void;
}

type AtomCommandFailureResult = Extract<
  AtomCommandResult<unknown, unknown>,
  { readonly _tag: "Failure" }
>;

export function getSupportedWorktreeDiscoveryMembers(
  members: ReadonlyArray<SidebarProjectGroupMember>,
  serverConfigs: ReadonlyMap<EnvironmentId, ServerConfig>,
): SidebarProjectGroupMember[] {
  return members.filter((member) => {
    const descriptor = serverConfigs.get(member.environmentId)?.environment;
    return descriptor !== undefined && isWorktreeCatalogSupported(descriptor);
  });
}

function adoptionThreadDefaults(
  member: SidebarProjectGroupMember,
  serverConfig: ServerConfig | undefined,
): WorktreeAdoptInput["threadDefaults"] {
  const settings = serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS;
  const fallbackProvider = serverConfig?.providers.find((provider) => provider.enabled);
  const targetInstanceId =
    member.defaultModelSelection?.instanceId ??
    fallbackProvider?.instanceId ??
    ProviderInstanceId.make("codex");
  const resolution = resolveProviderSessionSelectionForInstance({
    instanceId: targetInstanceId,
    providers: serverConfig?.providers ?? [],
    settings,
    projectSelection: member.defaultModelSelection,
  });
  return {
    modelSelection: resolution.modelSelection,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  };
}

function candidateInput(input: {
  readonly member: SidebarProjectGroupMember;
  readonly candidate: VcsWorktreeDescriptor;
  readonly generation: number;
  readonly serverConfig: ServerConfig | undefined;
}): WorktreeAdoptInput {
  return {
    commandId: newCommandId(),
    projectId: input.member.id,
    worktreeKey: input.candidate.worktreeKey,
    expectedGeneration: input.generation,
    threadDefaults: adoptionThreadDefaults(input.member, input.serverConfig),
  };
}

function EnvironmentBadge(props: {
  readonly environmentLabel: string;
  readonly isRemote: boolean;
}) {
  const { environmentLabel, isRemote } = props;
  const ariaLabel = isRemote
    ? `Remote environment: ${environmentLabel}`
    : `Local environment: ${environmentLabel}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={ariaLabel}
            className="inline-flex min-w-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground"
          />
        }
      >
        {isRemote ? <CloudIcon className="size-2.5" /> : <MonitorIcon className="size-2.5" />}
        <span className="truncate">{environmentLabel}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">{ariaLabel}</TooltipPopup>
    </Tooltip>
  );
}

function CandidateDetails(props: {
  readonly label: string;
  readonly path: string;
  readonly discoveredBadge?: boolean;
}) {
  return (
    <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left">
      <span className="flex min-w-0 max-w-full items-center gap-1.5">
        <span className="truncate text-[11px] font-medium text-foreground/90">{props.label}</span>
        {props.discoveredBadge ? (
          <span className="shrink-0 rounded bg-info/10 px-1 py-px text-[8px] font-medium uppercase tracking-wide text-info">
            Discovered
          </span>
        ) : null}
      </span>
      <span className="max-w-full truncate font-mono text-[9px] text-muted-foreground/75">
        {props.path}
      </span>
    </span>
  );
}

function PhysicalWorktreeDiscoverySection(props: {
  readonly member: SidebarProjectGroupMember;
  readonly serverConfig: ServerConfig;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly onNavigateToThread: (threadRef: ScopedThreadRef) => void;
}) {
  const { member, serverConfig, primaryEnvironmentId, onNavigateToThread } = props;
  const catalog = useEnvironmentQuery(
    worktreeEnvironment.catalog({
      environmentId: member.environmentId,
      input: { projectId: member.id },
    }),
  );
  const updatePolicy = useAtomCommand(worktreeEnvironment.updatePolicy, { reportFailure: false });
  const addOne = useAtomCommand(worktreeEnvironment.addOne, { reportFailure: false });
  const addAll = useAtomCommand(worktreeEnvironment.addAll, { reportFailure: false });
  const [locallyAcknowledgedGeneration, setLocallyAcknowledgedGeneration] = useState<number | null>(
    null,
  );
  const [manuallyExpanded, setManuallyExpanded] = useState(false);
  const [pendingWorktreeKeys, setPendingWorktreeKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [addAllPendingCount, setAddAllPendingCount] = useState(0);

  const snapshot = catalog.data;
  const discovery = useMemo(
    () =>
      snapshot === null
        ? null
        : deriveWorktreeDiscoveryState({ snapshot, policy: member.worktreeDiscovery }),
    [member.worktreeDiscovery, snapshot],
  );
  const allCandidates = useMemo(
    () =>
      discovery === null ? [] : [...discovery.newCandidates, ...discovery.acknowledgedCandidates],
    [discovery],
  );
  const initialPromptExpanded =
    snapshot !== null &&
    discovery?.showInitialPrompt === true &&
    locallyAcknowledgedGeneration !== snapshot.generation;
  const cardCandidates =
    initialPromptExpanded && !manuallyExpanded ? (discovery?.newCandidates ?? []) : allCandidates;
  const showDiscoveryCard =
    member.worktreeDiscovery.visibility === "hidden" &&
    (initialPromptExpanded || manuallyExpanded) &&
    cardCandidates.length > 0;
  const showCollapsedLine =
    member.worktreeDiscovery.visibility === "hidden" &&
    allCandidates.length > 0 &&
    !showDiscoveryCard &&
    (discovery?.showCollapsedHiddenLine === true ||
      locallyAcknowledgedGeneration === snapshot?.generation);
  const shownCandidates = discovery?.shownCandidates ?? [];
  const environmentLabel = member.environmentLabel ?? member.environmentId;
  const isRemote = primaryEnvironmentId !== null && member.environmentId !== primaryEnvironmentId;

  const groupsFor = useCallback(
    (candidates: ReadonlyArray<VcsWorktreeDescriptor>) =>
      buildWorktreeDiscoveryGroups([
        {
          environmentId: member.environmentId,
          environmentLabel,
          projectId: member.id,
          candidates,
        },
      ])[0]?.parentGroups ?? [],
    [environmentLabel, member.environmentId, member.id],
  );

  const reportCommandFailure = useCallback((title: string, result: AtomCommandFailureResult) => {
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      }),
    );
  }, []);

  const handleAddOne = useCallback(
    async (candidate: VcsWorktreeDescriptor) => {
      if (snapshot === null) return;
      setPendingWorktreeKeys((current) => new Set(current).add(candidate.worktreeKey));
      try {
        const result = await addOne({
          environmentId: member.environmentId,
          input: candidateInput({
            member,
            candidate,
            generation: snapshot.generation,
            serverConfig,
          }),
        });
        if (result._tag === "Failure") {
          reportCommandFailure(`Could not add ${candidate.branch ?? "detached worktree"}`, result);
          return;
        }
        onNavigateToThread(scopeThreadRef(member.environmentId, result.value.threadId));
      } finally {
        setPendingWorktreeKeys((current) => {
          const next = new Set(current);
          next.delete(candidate.worktreeKey);
          return next;
        });
      }
    },
    [addOne, member, onNavigateToThread, reportCommandFailure, serverConfig, snapshot],
  );

  const handleAddAll = useCallback(async () => {
    if (snapshot === null || cardCandidates.length === 0) return;
    setAddAllPendingCount(cardCandidates.length);
    try {
      const result = await addAll({
        environmentId: member.environmentId,
        input: {
          candidates: cardCandidates.map((candidate) =>
            candidateInput({
              member,
              candidate,
              generation: snapshot.generation,
              serverConfig,
            }),
          ),
        },
      });
      if (result._tag === "Failure") {
        reportCommandFailure("Could not add discovered worktrees", result);
        return;
      }
      const successCount = result.value.results.filter((item) => item._tag === "Success").length;
      toastManager.add(
        formatWorktreeAddAllSummary({
          successCount,
          failureCount: result.value.results.length - successCount,
        }),
      );
    } finally {
      setAddAllPendingCount(0);
    }
  }, [addAll, cardCandidates, member, reportCommandFailure, serverConfig, snapshot]);

  const handleKeepHidden = useCallback(async () => {
    if (snapshot === null) return;
    const result = await updatePolicy({
      environmentId: member.environmentId,
      input: {
        commandId: newCommandId(),
        projectId: member.id,
        acknowledgeGeneration: snapshot.generation,
        dismissInitialPrompt: true,
      },
    });
    if (result._tag === "Failure") {
      reportCommandFailure("Could not hide discovered worktrees", result);
      return;
    }
    setLocallyAcknowledgedGeneration(snapshot.generation);
    setManuallyExpanded(false);
  }, [member.environmentId, member.id, reportCommandFailure, snapshot, updatePolicy]);

  if (snapshot === null || discovery === null || allCandidates.length === 0) {
    return null;
  }

  return (
    <div
      className="flex w-full flex-col gap-1"
      data-environment-id={member.environmentId}
      data-project-id={member.id}
    >
      {showDiscoveryCard ? (
        <div
          className="mx-0.5 rounded-lg border border-border/75 bg-muted/30 p-2 shadow-xs"
          data-testid={`worktree-discovery-card-${member.environmentId}-${member.id}`}
        >
          <div className="mb-2 flex items-start gap-2">
            <FolderSearchIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium text-foreground">
                  Discovered worktrees
                </span>
                <EnvironmentBadge environmentLabel={environmentLabel} isRemote={isRemote} />
              </div>
              <p className="mt-0.5 text-[9px] leading-3 text-muted-foreground">
                Add existing Git worktrees to use them in BiBCode.
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            {groupsFor(cardCandidates).map((parentGroup) => (
              <div key={parentGroup.parentDirectory} className="flex flex-col gap-0.5">
                <div className="truncate px-1 font-mono text-[8px] text-muted-foreground/65">
                  {parentGroup.parentDirectory}
                </div>
                {parentGroup.candidates.map(({ candidate, label }) => {
                  const pending = pendingWorktreeKeys.has(candidate.worktreeKey);
                  return (
                    <div
                      key={candidate.worktreeKey}
                      className="flex min-w-0 items-center gap-1 rounded-md bg-background/65 px-1.5 py-1"
                    >
                      <CandidateDetails label={label} path={candidate.path} />
                      <Button
                        aria-label={`Add ${label} to BiBCode`}
                        className="h-5 shrink-0 px-1.5 text-[9px]"
                        disabled={pending || addAllPendingCount > 0}
                        size="xs"
                        variant="ghost"
                        onClick={() => void handleAddOne(candidate)}
                      >
                        {pending ? <LoaderIcon className="size-3 animate-spin" /> : <PlusIcon />}
                        Add
                      </Button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          <div className="mt-2 flex items-center justify-end gap-1">
            <Button
              aria-label="Keep hidden"
              className="h-5 px-1.5 text-[9px]"
              disabled={addAllPendingCount > 0}
              size="xs"
              variant="ghost"
              onClick={() => void handleKeepHidden()}
            >
              Keep hidden
            </Button>
            <Button
              aria-label="Add all discovered worktrees"
              className="h-5 px-1.5 text-[9px]"
              disabled={addAllPendingCount > 0}
              size="xs"
              variant="secondary"
              onClick={() => void handleAddAll()}
            >
              {addAllPendingCount > 0 ? (
                <>
                  <LoaderIcon className="size-3 animate-spin" />
                  Adding {formatDiscoveredWorktreeCount(addAllPendingCount)}…
                </>
              ) : (
                <>Add all</>
              )}
            </Button>
          </div>
        </div>
      ) : null}

      {showCollapsedLine ? (
        <Button
          aria-label={`Hiding ${formatDiscoveredWorktreeCount(allCandidates.length)}`}
          className="h-6 w-full justify-start gap-1.5 px-2 text-[9px] text-muted-foreground"
          size="xs"
          variant="ghost"
          onClick={() => setManuallyExpanded(true)}
        >
          <EyeOffIcon className="size-3" />
          <span>{`Hiding ${formatDiscoveredWorktreeCount(allCandidates.length)}`}</span>
          <ChevronRightIcon className="ml-auto size-3" />
        </Button>
      ) : null}

      {shownCandidates.length > 0
        ? groupsFor(shownCandidates).flatMap((parentGroup) =>
            parentGroup.candidates.map(({ candidate, label }) => {
              const pending = pendingWorktreeKeys.has(candidate.worktreeKey);
              return (
                <Button
                  key={candidate.worktreeKey}
                  aria-label={`Add discovered worktree ${label} to BiBCode`}
                  className="h-auto w-full justify-start rounded-md border border-dashed border-info/25 bg-info/5 px-2 py-1.5"
                  disabled={pending || addAllPendingCount > 0}
                  size="content"
                  variant="ghost"
                  onClick={() => void handleAddOne(candidate)}
                >
                  {pending ? (
                    <LoaderIcon className="size-3 shrink-0 animate-spin" />
                  ) : (
                    <PlusIcon className="size-3 shrink-0 text-info" />
                  )}
                  <CandidateDetails discoveredBadge label={label} path={candidate.path} />
                  <EnvironmentBadge environmentLabel={environmentLabel} isRemote={isRemote} />
                </Button>
              );
            }),
          )
        : null}
    </div>
  );
}

export function WorktreeDiscoverySection(props: WorktreeDiscoverySectionProps) {
  const { project, serverConfigs, primaryEnvironmentId = null, onNavigateToThread } = props;
  const supportedMembers = useMemo(
    () => getSupportedWorktreeDiscoveryMembers(project.memberProjects, serverConfigs),
    [project.memberProjects, serverConfigs],
  );
  const subscribedProjects = useMemo(
    () =>
      supportedMembers.map((member) => ({
        environmentId: member.environmentId,
        projectId: member.id,
      })),
    [supportedMembers],
  );
  useWorktreeCatalogFocusRefresh(subscribedProjects);

  if (supportedMembers.length === 0) {
    return null;
  }

  return (
    <>
      {supportedMembers.map((member) => (
        <PhysicalWorktreeDiscoverySection
          key={member.physicalProjectKey}
          member={member}
          serverConfig={serverConfigs.get(member.environmentId)!}
          primaryEnvironmentId={primaryEnvironmentId}
          onNavigateToThread={onNavigateToThread}
        />
      ))}
    </>
  );
}
