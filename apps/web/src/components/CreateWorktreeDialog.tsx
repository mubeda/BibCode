"use client";

// TODO(orca-port): this is a first working pass wired against the plan in
// .superpowers/orca-port/00-port-plan.md and w2-findings.md. Several exact
// field/prop names are best-effort (marked below) and should be re-verified
// against tsgo/runtime once S1's pinned interfaces (kind field, vcs.clone)
// land and this can be re-tested end-to-end.

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@bibcode/client-runtime/state/runtime";
import {
  parseScopedProjectKey,
  scopedProjectKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@bibcode/client-runtime/environment";
import type { EnvironmentId, ScopedProjectRef } from "@bibcode/contracts";
import {
  DEFAULT_DEFAULT_AGENT_SELECTION,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
} from "@bibcode/contracts";
import { useNavigate } from "@tanstack/react-router";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { newCommandId, newThreadId } from "~/lib/utils";
import { resolveProviderSessionSelectionForInstance } from "~/providerSessionSelection";
import { useCenterPanelStore } from "~/centerPanelStore";
import { useProjects, useServerConfigs } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { worktreeEnvironment } from "~/state/worktrees";

import {
  buildSmartRows,
  detectSmartMode,
  filterRefsByQuery,
  getCreateWorktreeDisabled,
  parseGitHubWorkItem,
  resolveWorktreeCreateInput,
  type GitHubWorkItemRef,
  type RefLike,
  type SmartRow,
  type WorktreeNameMode,
} from "./CreateWorktreeDialog.logic";
import { Button } from "./ui/button";
import { Collapsible, CollapsibleTrigger, CollapsiblePanel } from "./ui/collapsible";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Kbd } from "./ui/kbd";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Switch } from "./ui/switch";
import { stackedThreadToast, toastManager } from "./ui/toast";
import {
  buildProviderAgentActions,
  isProviderAgentActionSelectable,
  resolveEffectiveProviderAgentAction,
} from "./chat/providerAgentActions";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";

export interface CreateWorktreeDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly defaultProjectRef?: ScopedProjectRef | null;
}

interface WorktreeProjectSelection {
  readonly projectRef: ScopedProjectRef | null;
  readonly branchRefName: string | null;
}

function sameProjectRef(left: ScopedProjectRef | null, right: ScopedProjectRef | null): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.environmentId === right.environmentId &&
      left.projectId === right.projectId)
  );
}

const TAB_OPTIONS: ReadonlyArray<{ value: WorktreeNameMode; label: string }> = [
  { value: "smart", label: "Smart" },
  { value: "github", label: "GitHub" },
  { value: "branch", label: "Branch" },
  { value: "name", label: "Name" },
];

export function CreateWorktreeDialog({
  open,
  onOpenChange,
  defaultProjectRef = null,
}: CreateWorktreeDialogProps) {
  const navigate = useNavigate();
  const nameInputRef = useRef<HTMLInputElement>(null);

  const projects = useProjects();
  const serverConfigs = useServerConfigs();

  const [projectSelection, setProjectSelection] = useState<WorktreeProjectSelection>(() => ({
    projectRef: defaultProjectRef,
    branchRefName: null,
  }));
  const { projectRef, branchRefName } = projectSelection;
  const [mode, setMode] = useState<WorktreeNameMode>("smart");
  const [nameText, setNameText] = useState("");
  const [baseBranchOverride, setBaseBranchOverride] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [createMore, setCreateMore] = useState(false);
  const [agentActionValue, setAgentActionValue] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const agentSelectionTouchedRef = useRef(false);
  const previousOpenRef = useRef(false);
  const refsEnabledRef = useRef(false);

  const selectProjectTarget = useCallback((nextProjectRef: ScopedProjectRef | null) => {
    setProjectSelection((current) =>
      sameProjectRef(current.projectRef, nextProjectRef)
        ? current
        : { projectRef: nextProjectRef, branchRefName: null },
    );
  }, []);
  const selectBranchRef = useCallback((branchRef: RefLike | null) => {
    setProjectSelection((current) => ({ ...current, branchRefName: branchRef?.name ?? null }));
  }, []);

  // A fresh query/tab invalidates whatever branch row was previously picked.
  useEffect(() => {
    selectBranchRef(null);
  }, [nameText, mode, selectBranchRef]);

  useEffect(() => {
    const wasOpen = previousOpenRef.current;
    previousOpenRef.current = open;
    if (!open) return;
    if (!wasOpen) {
      agentSelectionTouchedRef.current = false;
    }
    const firstProject = projects[0];
    const firstProjectRef = firstProject
      ? scopeProjectRef(firstProject.environmentId, firstProject.id)
      : null;
    setProjectSelection((current) => {
      const nextProjectRef = defaultProjectRef ?? current.projectRef ?? firstProjectRef;
      if (!wasOpen) {
        return { projectRef: nextProjectRef, branchRefName: null };
      }
      if (current.projectRef !== null) return current;
      return sameProjectRef(current.projectRef, nextProjectRef)
        ? current
        : { projectRef: nextProjectRef, branchRefName: null };
    });
    const frame = window.requestAnimationFrame(() => {
      nameInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, defaultProjectRef, projects]);

  const project = useMemo(
    () =>
      projects.find(
        (candidate) =>
          candidate.id === projectRef?.projectId &&
          candidate.environmentId === projectRef.environmentId,
      ) ?? null,
    [projects, projectRef],
  );
  const environmentId: EnvironmentId | null = project?.environmentId ?? null;
  const cwd = project?.workspaceRoot ?? null;

  const branchesEnabled =
    (mode === "branch" || mode === "smart") && cwd !== null && environmentId !== null;
  const refsQuery = useEnvironmentQuery(
    branchesEnabled && environmentId !== null && cwd !== null
      ? vcsEnvironment.listRefs({
          environmentId,
          input: { cwd, query: nameText.trim() || undefined },
        })
      : null,
  );
  const refsEnabled = open && branchesEnabled;
  useEffect(() => {
    const wasEnabled = refsEnabledRef.current;
    refsEnabledRef.current = refsEnabled;
    if (refsEnabled && !wasEnabled) refsQuery.refresh();
  }, [refsEnabled, refsQuery.refresh]);
  // TODO(orca-port): confirm VcsListRefsResult field name is `refs`.
  const refs: ReadonlyArray<RefLike> = refsQuery.data?.refs ?? [];
  const selectedBranchRef = useMemo(
    () => refs.find((ref) => ref.name === branchRefName) ?? null,
    [branchRefName, refs],
  );
  const selectedBranchRefName = selectedBranchRef?.name ?? null;

  const githubItem: GitHubWorkItemRef | null =
    mode === "github" || mode === "smart" ? parseGitHubWorkItem(nameText) : null;

  const smartRows: SmartRow[] = useMemo(
    () => (mode === "smart" ? buildSmartRows({ query: nameText, refs }) : []),
    [mode, nameText, refs],
  );
  const branchRows = useMemo(
    () => (mode === "branch" ? filterRefsByQuery(refs, nameText) : []),
    [mode, nameText, refs],
  );
  const smartDetectedMode = useMemo(
    () => (mode === "smart" ? detectSmartMode(nameText, refs) : mode),
    [mode, nameText, refs],
  );

  const serverConfig = environmentId ? serverConfigs.get(environmentId) : undefined;
  const agentActions = useMemo(
    () =>
      serverConfig ? buildProviderAgentActions(serverConfig.providers, serverConfig.settings) : [],
    [serverConfig],
  );
  const selectableAgentActions = useMemo(
    () => agentActions.filter(isProviderAgentActionSelectable),
    [agentActions],
  );
  const effectiveDefaultAgent = resolveEffectiveProviderAgentAction(
    agentActions,
    serverConfig?.settings.defaultAgent ?? DEFAULT_DEFAULT_AGENT_SELECTION,
  );

  useEffect(() => {
    if (!open) return;
    const selectionAvailable = selectableAgentActions.some(
      (action) => action.value === agentActionValue,
    );
    if (!agentSelectionTouchedRef.current || !selectionAvailable) {
      agentSelectionTouchedRef.current = false;
      setAgentActionValue(effectiveDefaultAgent?.value ?? null);
    }
  }, [agentActionValue, effectiveDefaultAgent, open, selectableAgentActions]);

  const resolution = useMemo(
    () =>
      resolveWorktreeCreateInput({
        mode,
        nameText,
        selectedBranchRefName,
        githubItem,
        advancedBaseBranchOverride: baseBranchOverride || null,
        defaultBaseBranch: null,
      }),
    [mode, nameText, selectedBranchRefName, githubItem, baseBranchOverride],
  );

  const createManagedWorktree = useAtomCommand(worktreeEnvironment.createManaged, {
    reportFailure: false,
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const createDisabled = getCreateWorktreeDisabled({
    hasProject: project !== null,
    resolution,
    isSubmitting,
  });

  const resetForNextCreate = useCallback(() => {
    setNameText("");
    selectBranchRef(null);
    setFormError(null);
    window.requestAnimationFrame(() => nameInputRef.current?.focus());
  }, [selectBranchRef]);

  const handleSubmit = useCallback(async () => {
    if (!project || !environmentId || !cwd || !resolution) {
      setFormError("Choose a project and a name/branch to create the worktree from.");
      return;
    }
    setFormError(null);
    setIsSubmitting(true);
    try {
      const threadId = newThreadId();
      const settings = serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS;
      const requestedAction = selectableAgentActions.find(
        (action) => action.value === agentActionValue,
      );
      const selectedAction =
        requestedAction ?? resolveEffectiveProviderAgentAction(agentActions, settings.defaultAgent);
      const targetInstanceId =
        selectedAction?.entry.instanceId ??
        project.defaultModelSelection?.instanceId ??
        ProviderInstanceId.make("codex");
      const resolvedDefault = resolveProviderSessionSelectionForInstance({
        instanceId: targetInstanceId,
        providers: serverConfig?.providers ?? [],
        settings,
        projectSelection: project.defaultModelSelection,
      });
      if (resolvedDefault.fallback) {
        console.warn("Provider session default fallback", resolvedDefault.fallback);
      }

      const worktreeResult = await createManagedWorktree({
        environmentId,
        input: {
          commandId: newCommandId(),
          threadId,
          projectId: project.id,
          title: resolution.branchName,
          refName: resolution.refName,
          newRefName: resolution.newRefName,
          baseRefName: resolution.baseRefName,
          threadDefaults: {
            modelSelection: resolvedDefault.modelSelection,
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          },
        },
      });
      if (worktreeResult._tag === "Failure") {
        if (!isAtomCommandInterrupted(worktreeResult)) {
          const error = squashAtomCommandFailure(worktreeResult);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to create worktree",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }

      if (selectedAction?.kind === "terminal" && selectedAction.terminalAction.command !== null) {
        useCenterPanelStore
          .getState()
          .replaceMainWithTerminal(scopeThreadRef(environmentId, threadId), [], {
            label: selectedAction.terminalAction.label,
            command: selectedAction.terminalAction.command,
          });
      }

      if (createMore) {
        resetForNextCreate();
        return;
      }

      onOpenChange(false);
      // Verified against routeTree.gen.ts: "/$environmentId/$threadId" is the
      // FileRoutesByTo id for routes/_chat.$environmentId.$threadId.tsx.
      void navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });
    } finally {
      setIsSubmitting(false);
    }
  }, [
    project,
    environmentId,
    cwd,
    resolution,
    createManagedWorktree,
    agentActionValue,
    agentActions,
    selectableAgentActions,
    serverConfig,
    createMore,
    resetForNextCreate,
    onOpenChange,
    navigate,
  ]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        if (!createDisabled) void handleSubmit();
      }
    },
    [createDisabled, handleSubmit],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isSubmitting) onOpenChange(nextOpen);
      }}
    >
      <DialogPopup className="max-w-xl" onKeyDown={handleKeyDown}>
        <DialogHeader>
          <DialogTitle>Create worktree</DialogTitle>
          <DialogDescription>
            Create a new worktree and thread from a project, branch, or GitHub issue/PR.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <label className="grid gap-1.5">
            <span className="text-foreground text-xs font-medium">Project</span>
            <Select
              modal={false}
              value={projectRef ? scopedProjectKey(projectRef) : undefined}
              onValueChange={(value) => {
                if (value === null) return;
                const nextProjectRef = parseScopedProjectKey(value);
                if (nextProjectRef) selectProjectTarget(nextProjectRef);
              }}
              items={projects.map((p) => ({
                value: scopedProjectKey(scopeProjectRef(p.environmentId, p.id)),
                label: p.title,
              }))}
            >
              <SelectTrigger aria-label="Project">
                <SelectValue placeholder="Select a project" />
              </SelectTrigger>
              <SelectPopup>
                <SelectGroup>
                  {projects.map((p) => (
                    <SelectItem
                      key={scopedProjectKey(scopeProjectRef(p.environmentId, p.id))}
                      value={scopedProjectKey(scopeProjectRef(p.environmentId, p.id))}
                    >
                      {p.title}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectPopup>
            </Select>
          </label>

          <div className="grid gap-1.5">
            {/* TODO(orca-port): swap for ui/toggle-group's segmented control
                once its single-select value API (string vs string[]) is
                confirmed; plain buttons are a safe first pass. */}
            <div className="flex gap-1">
              {TAB_OPTIONS.map((tab) => (
                <Button
                  key={tab.value}
                  type="button"
                  size="sm"
                  variant={mode === tab.value ? "default" : "outline"}
                  onClick={() => setMode(tab.value)}
                >
                  {tab.label}
                </Button>
              ))}
            </div>

            <Input
              ref={nameInputRef}
              placeholder={
                mode === "github"
                  ? "#1234 or a GitHub issue/PR URL"
                  : mode === "branch"
                    ? "Search branches"
                    : mode === "name"
                      ? "Worktree / branch name"
                      : "Type a name, #1234, or a branch"
              }
              value={nameText}
              onChange={(event) => setNameText(event.target.value)}
            />

            {mode === "smart" && smartRows.length > 0 ? (
              <div className="border-border/70 rounded-lg border">
                {smartRows.map((row) => (
                  <button
                    key={
                      row.kind === "github"
                        ? `github-${row.item.number}`
                        : row.kind === "branch"
                          ? `branch-${row.refName}`
                          : "use-name"
                    }
                    type="button"
                    className={cn(
                      "hover:bg-accent flex w-full items-center justify-between px-3 py-1.5 text-left text-sm",
                      row.kind === "branch" && row.refName === selectedBranchRefName && "bg-accent",
                    )}
                    onClick={() => {
                      if (row.kind === "branch") {
                        selectBranchRef(refs.find((ref) => ref.name === row.refName) ?? null);
                      }
                    }}
                  >
                    <span>
                      {row.kind === "github"
                        ? `GitHub #${row.item.number}`
                        : row.kind === "branch"
                          ? row.refName
                          : `Use "${row.name}"`}
                    </span>
                    <span className="text-muted-foreground text-xs capitalize">{row.kind}</span>
                  </button>
                ))}
              </div>
            ) : null}

            {mode === "branch" && branchRows.length > 0 ? (
              <div className="border-border/70 max-h-48 overflow-y-auto rounded-lg border">
                {branchRows.map((ref) => (
                  <button
                    key={ref.name}
                    type="button"
                    className={cn(
                      "hover:bg-accent flex w-full items-center px-3 py-1.5 text-left text-sm",
                      ref.name === selectedBranchRefName && "bg-accent",
                    )}
                    onClick={() => selectBranchRef(ref)}
                  >
                    {ref.name}
                  </button>
                ))}
              </div>
            ) : null}

            {selectedBranchRef &&
            selectedBranchRef.isRemote !== true &&
            (selectedBranchRef.current === true || selectedBranchRef.worktreePath != null) ? (
              <p className="text-muted-foreground text-xs" role="status">
                &quot;{selectedBranchRef.name}&quot; is already checked out. A new branch (&quot;
                {selectedBranchRef.name}-2&quot; or the next available name) will be created from
                it.
              </p>
            ) : null}

            {mode === "smart" ? (
              <p className="text-muted-foreground text-xs">
                Interpreting as: <span className="font-medium capitalize">{smartDetectedMode}</span>
              </p>
            ) : null}
          </div>

          <label className="grid gap-1.5">
            <span className="text-foreground text-xs font-medium">Agent</span>
            <Select
              modal={false}
              value={agentActionValue ?? undefined}
              onValueChange={(value) => {
                agentSelectionTouchedRef.current = true;
                setAgentActionValue(value as string);
              }}
              items={selectableAgentActions.map((action) => ({
                value: action.value,
                label: action.label,
              }))}
            >
              <SelectTrigger aria-label="Agent">
                <SelectValue placeholder="Select an agent" />
              </SelectTrigger>
              <SelectPopup>
                <SelectGroup>
                  <SelectGroupLabel>Agent</SelectGroupLabel>
                  {selectableAgentActions.map((action) => (
                    <SelectItem key={action.value} value={action.value}>
                      <ProviderInstanceIcon
                        driverKind={action.entry.driverKind}
                        displayName={action.entry.displayName}
                        accentColor={action.entry.accentColor}
                        iconClassName="size-4"
                      />
                      {action.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectPopup>
            </Select>
          </label>

          <Collapsible open={showAdvanced} onOpenChange={setShowAdvanced}>
            <CollapsibleTrigger className="text-muted-foreground hover:text-foreground text-sm font-medium">
              {showAdvanced ? "Hide advanced" : "Advanced"}
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <label className="grid gap-1.5 pt-2">
                <span className="text-foreground text-xs font-medium">Base branch override</span>
                <Input
                  placeholder="Defaults to the current branch"
                  value={baseBranchOverride}
                  onChange={(event) => setBaseBranchOverride(event.target.value)}
                />
              </label>
            </CollapsiblePanel>
          </Collapsible>

          {formError ? <p className="text-destructive text-xs">{formError}</p> : null}
        </DialogPanel>
        <DialogFooter className="items-center justify-between">
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={createMore} onCheckedChange={setCreateMore} />
            Create more
          </label>
          <Button type="button" disabled={createDisabled} onClick={() => void handleSubmit()}>
            {isSubmitting ? "Creating..." : "Create worktree"}
            <Kbd>Ctrl+Enter</Kbd>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
