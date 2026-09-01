import { RegistryContext } from "@effect/atom-react";
import type {
  EnvironmentId,
  GitManagerOperationEvent,
  GitManagerOperationRequest,
  GitManagerRefEntry,
  ScopedProjectRef,
} from "@bibcode/contracts";
import * as Cause from "effect/Cause";
import { GitMergeIcon, SearchIcon } from "lucide-react";
import {
  memo,
  type ChangeEvent,
  useCallback,
  useContext,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import {
  gitManagerEnvironment,
  runGitManagerOperation,
  type GitManagerOperationHandle,
} from "~/state/gitManager";
import { useEnvironmentQuery } from "~/state/query";

import { GitManagerOperationBanner } from "../toolbar/GitManagerOperationBanner";
import { groupBranches } from "../toolbar/branchGrouping";
import { resolveMergeConfirmCopy, summarizeMergePreview } from "./GitManagerMergeDialog.logic";

const NO_RECENT_BRANCHES: ReadonlyArray<string> = Object.freeze([]);
const noop = () => undefined;

export interface GitManagerMergeDialogProps {
  readonly open: boolean;
  readonly scope: { readonly environmentId: EnvironmentId; readonly cwd: string };
  readonly projectRef: ScopedProjectRef;
  readonly refs: ReadonlyArray<GitManagerRefEntry>;
  readonly recentNames?: ReadonlyArray<string>;
  readonly disabledReason?: string | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onFinished?: () => void;
}

export const GitManagerMergeDialog = memo(function GitManagerMergeDialog({
  open,
  scope,
  projectRef,
  refs,
  recentNames = NO_RECENT_BRANCHES,
  disabledReason: capabilityDisabledReason = null,
  onOpenChange,
  onFinished = noop,
}: GitManagerMergeDialogProps) {
  const registry = useContext(RegistryContext);
  const { environmentId, cwd } = scope;
  const [mode, setMode] = useState<"merge" | "squash">("merge");
  const [filter, setFilter] = useState("");
  const [selectedSourceName, setSelectedSourceName] = useState<string | null>(null);
  const [operationEvent, setOperationEvent] = useState<GitManagerOperationEvent | null>(null);
  const [failureCode, setFailureCode] = useState<string | null>(null);
  const [failureMessage, setFailureMessage] = useState<string | null>(null);
  const [operationRunning, setOperationRunning] = useState(false);
  const activeOperationRef = useRef<GitManagerOperationHandle | null>(null);
  useEffect(
    () => () => {
      activeOperationRef.current?.cancel();
    },
    [],
  );

  const deferredFilter = useDeferredValue(filter);
  const grouped = useMemo(
    () => groupBranches({ refs, recentNames, filter: deferredFilter }),
    [deferredFilter, recentNames, refs],
  );
  const sourceBranches = useMemo(
    () =>
      [...grouped.default, ...grouped.recent, ...grouped.other].filter((branch) => !branch.current),
    [grouped.default, grouped.other, grouped.recent],
  );
  const selectedBranch =
    sourceBranches.find((branch) => branch.name === selectedSourceName) ??
    sourceBranches[0] ??
    null;
  const selectedSource = selectedBranch?.name ?? null;
  const operationTag = mode === "merge" ? "merge" : "squash-merge";
  const blockedReason =
    selectedBranch?.blocked.find((reason) => reason.operation === operationTag) ?? null;

  const previewAtom = useMemo(
    () =>
      !open || selectedSource === null || capabilityDisabledReason !== null
        ? null
        : gitManagerEnvironment.previewMerge({
            environmentId,
            input: { cwd, source: selectedSource },
          }),
    [capabilityDisabledReason, cwd, environmentId, open, selectedSource],
  );
  const previewQuery = useEnvironmentQuery(previewAtom);
  const preview = previewQuery.data?.source === selectedSource ? previewQuery.data : null;
  const summary = preview === null ? null : summarizeMergePreview(preview);
  const copy = resolveMergeConfirmCopy(mode);
  const disabledReason =
    capabilityDisabledReason ??
    blockedReason?.message ??
    (operationRunning
      ? "The selected Git operation is running."
      : selectedSource === null
        ? "Choose a source branch."
        : previewQuery.isPending || preview === null
          ? "Loading merge preview."
          : summary?.mergeEnabled === false
            ? summary.message
            : null);
  const confirmDisabled = disabledReason !== null;
  const disabledReasonId =
    disabledReason === null ? undefined : "git-manager-merge-disabled-reason";

  const changeFilter = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setFilter(event.currentTarget.value),
    [],
  );
  const chooseMerge = useCallback(() => setMode("merge"), []);
  const chooseSquash = useCallback(() => setMode("squash"), []);
  const close = useCallback(() => {
    if (!operationRunning) onOpenChange(false);
  }, [onOpenChange, operationRunning]);
  const cancelOperation = useCallback(() => {
    activeOperationRef.current?.cancel();
    activeOperationRef.current = null;
    setOperationRunning(false);
  }, []);
  const confirm = useCallback(() => {
    if (confirmDisabled || selectedSource === null || activeOperationRef.current !== null) return;
    const input: GitManagerOperationRequest = {
      _tag: operationTag,
      cwd,
      projectId: projectRef.projectId,
      source: selectedSource,
      noVerify: false,
    };
    setFailureCode(null);
    setFailureMessage(null);
    setOperationRunning(true);
    setOperationEvent({ _tag: "started", operation: operationTag });
    const handle = runGitManagerOperation(registry, { environmentId, input }, (event) => {
      setOperationEvent(event);
      if (event._tag === "failed") {
        setOperationRunning(false);
        setFailureCode(event.code);
        setFailureMessage(event.blocked?.message ?? event.message);
      } else if (event._tag === "finished") {
        setOperationRunning(false);
        onFinished();
        onOpenChange(false);
      }
    });
    activeOperationRef.current = handle;
    void handle.result.then((result) => {
      if (activeOperationRef.current === handle) activeOperationRef.current = null;
      if (result._tag !== "Failure" || Cause.hasInterruptsOnly(result.cause)) return;
      const error = Cause.squash(result.cause);
      const message = error instanceof Error ? error.message : "The merge operation failed.";
      setOperationRunning(false);
      setFailureCode("transport-error");
      setFailureMessage(message);
      setOperationEvent({
        _tag: "failed",
        operation: operationTag,
        code: "transport-error",
        message,
        blocked: null,
      });
    });
  }, [
    confirmDisabled,
    cwd,
    environmentId,
    onFinished,
    onOpenChange,
    operationTag,
    projectRef.projectId,
    registry,
    selectedSource,
  ]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>
            Select a local source branch and review the server-computed merge preview.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-3 px-6 pb-4">
          <div className="flex gap-2" role="group" aria-label="Merge mode">
            <Button
              aria-pressed={mode === "merge"}
              size="sm"
              variant="outline"
              onClick={chooseMerge}
            >
              Merge commit
            </Button>
            <Button
              aria-pressed={mode === "squash"}
              size="sm"
              variant="outline"
              onClick={chooseSquash}
            >
              Squash merge
            </Button>
          </div>
          <label className="relative block">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <span className="sr-only">Filter source branches</span>
            <Input
              aria-label="Filter source branches"
              className="[&_input]:pl-7"
              placeholder="Filter branches…"
              size="sm"
              type="search"
              value={filter}
              onChange={changeFilter}
            />
          </label>
          <div
            aria-label="Source branches"
            className="max-h-44 overflow-auto rounded-md border border-border"
          >
            {sourceBranches.length === 0 ? (
              <p className="p-3 text-xs text-muted-foreground">No source branches found.</p>
            ) : (
              sourceBranches.map((branch) => (
                <button
                  aria-pressed={branch.name === selectedSource}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring aria-pressed:bg-accent"
                  key={branch.name}
                  type="button"
                  onClick={() => setSelectedSourceName(branch.name)}
                >
                  <GitMergeIcon aria-hidden="true" className="size-3.5" />
                  <span className="truncate font-mono">{branch.name}</span>
                </button>
              ))
            )}
          </div>
          <div aria-live="polite" className="min-h-10 rounded-md bg-muted/35 p-3 text-xs">
            {previewQuery.error !== null && preview === null ? (
              <p className="text-destructive">{previewQuery.error}</p>
            ) : summary === null ? (
              <p className="text-muted-foreground">Loading merge preview…</p>
            ) : (
              <>
                <p>{summary.message}</p>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  Ahead {summary.ahead} · Behind {summary.behind}
                </p>
              </>
            )}
          </div>
          {blockedReason === null ? null : (
            <p className="text-xs text-destructive">{blockedReason.message}</p>
          )}
          {failureCode === null ? null : (
            <p aria-live="polite" className="text-xs text-destructive">
              {failureMessage} <code className="font-mono">({failureCode})</code>
            </p>
          )}
          <GitManagerOperationBanner operation={operationEvent} onCancel={cancelOperation} />
          {disabledReason === null ? null : (
            <span className="sr-only" id={disabledReasonId}>
              {disabledReason}
            </span>
          )}
        </div>
        <DialogFooter>
          <Button disabled={operationRunning} variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button
            aria-describedby={disabledReasonId}
            disabled={confirmDisabled}
            title={disabledReason ?? undefined}
            onClick={confirm}
          >
            {copy.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
});
