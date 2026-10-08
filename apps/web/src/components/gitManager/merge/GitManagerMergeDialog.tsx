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
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "~/components/ui/combobox";
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
import {
  MERGE_PREVIEW_GIT_TOO_OLD_PREFIX,
  resolveMergeConfirmCopy,
  summarizeMergePreview,
} from "./GitManagerMergeDialog.logic";

// The mode buttons carry `aria-pressed`, which the shared Button styles do not
// read (they key on Base UI's `data-pressed`), so the selected mode needs its
// own frame: primary border and tint, the app's selected-state vocabulary.
const MERGE_MODE_BUTTON_CLASS =
  "aria-pressed:border-primary aria-pressed:bg-primary/15 aria-pressed:text-foreground";

const NO_RECENT_BRANCHES: ReadonlyArray<string> = Object.freeze([]);
const NO_REFS: ReadonlyArray<GitManagerRefEntry> = Object.freeze([]);
// Repository-wide blocks that apply whatever the source is, so a remote source (which has
// no per-branch guards) still shows them before the click.
const REPOSITORY_BLOCK_CODES: ReadonlySet<string> = new Set([
  "dirty-working-tree",
  "merge-in-progress",
]);

interface MergeSourceOption {
  /** Full ref sent to the server, so a local branch named like a remote one stays distinct. */
  readonly ref: string;
  readonly label: string;
  readonly entry: GitManagerRefEntry;
  readonly remote: boolean;
}
const noop = () => undefined;

export interface GitManagerMergeDialogProps {
  readonly open: boolean;
  readonly scope: { readonly environmentId: EnvironmentId; readonly cwd: string };
  readonly projectRef: ScopedProjectRef;
  readonly refs: ReadonlyArray<GitManagerRefEntry>;
  readonly remoteRefs?: ReadonlyArray<GitManagerRefEntry>;
  readonly recentNames?: ReadonlyArray<string>;
  readonly disabledReason?: string | null;
  /** The server can merge into a branch that is not checked out (`merge-into`). */
  readonly mergeIntoAvailable?: boolean;
  /** "current-branch" merges only into the checked-out branch and hides the Into picker. */
  readonly targetMode?: "any-target" | "current-branch";
  readonly onOpenChange: (open: boolean) => void;
  readonly onFinished?: () => void;
}

function MergeSourceButton({
  option,
  selected,
  onSelect,
}: {
  readonly option: MergeSourceOption;
  readonly selected: boolean;
  readonly onSelect: (ref: string) => void;
}) {
  return (
    <button
      aria-pressed={selected}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring aria-pressed:bg-accent"
      type="button"
      onClick={() => onSelect(option.ref)}
    >
      <GitMergeIcon aria-hidden="true" className="size-3.5" />
      <span className="truncate font-mono">{option.label}</span>
    </button>
  );
}

export const GitManagerMergeDialog = memo(function GitManagerMergeDialog({
  open,
  scope,
  projectRef,
  refs,
  remoteRefs = NO_REFS,
  recentNames = NO_RECENT_BRANCHES,
  disabledReason: capabilityDisabledReason = null,
  mergeIntoAvailable = false,
  targetMode = "any-target",
  onOpenChange,
  onFinished = noop,
}: GitManagerMergeDialogProps) {
  const registry = useContext(RegistryContext);
  const { environmentId, cwd } = scope;
  const [mode, setMode] = useState<"merge" | "squash">("merge");
  const [filter, setFilter] = useState("");
  const [selectedSourceRef, setSelectedSourceRef] = useState<string | null>(null);
  const [targetName, setTargetName] = useState<string | null>(null);
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

  const currentName = useMemo(() => refs.find((ref) => ref.current)?.name ?? null, [refs]);
  const targetNames = useMemo(() => refs.map((ref) => ref.name), [refs]);
  const showTargetPicker = mergeIntoAvailable && targetMode !== "current-branch";
  const target = (showTargetPicker ? targetName : null) ?? currentName;
  const intoOtherBranch = showTargetPicker && target !== null && target !== currentName;

  const deferredFilter = useDeferredValue(filter);
  const grouped = useMemo(
    () => groupBranches({ refs, remoteRefs, recentNames, filter: deferredFilter }),
    [deferredFilter, recentNames, refs, remoteRefs],
  );
  const localSourceOptions = useMemo(
    (): ReadonlyArray<MergeSourceOption> =>
      // The target cannot be its own source; the checked-out branch is a source for
      // another target.
      [...grouped.default, ...grouped.recent, ...grouped.other]
        .filter((branch) => branch.name !== target)
        .map((entry) => ({
          ref: `refs/heads/${entry.name}`,
          label: entry.name,
          entry,
          remote: false,
        })),
    [grouped.default, grouped.other, grouped.recent, target],
  );
  const remoteSourceOptions = useMemo(
    (): ReadonlyArray<MergeSourceOption> =>
      grouped.remote.map((entry) => ({
        ref: `refs/remotes/${entry.name}`,
        label: entry.name,
        entry,
        remote: true,
      })),
    [grouped.remote],
  );
  const selectedOption =
    localSourceOptions.find((option) => option.ref === selectedSourceRef) ??
    remoteSourceOptions.find((option) => option.ref === selectedSourceRef) ??
    localSourceOptions[0] ??
    remoteSourceOptions[0] ??
    null;
  const selectedSource = selectedOption?.ref ?? null;
  const effectiveMode = intoOtherBranch ? "merge" : mode;
  const operationTag = intoOtherBranch
    ? "merge-into"
    : effectiveMode === "merge"
      ? "merge"
      : "squash-merge";
  const repositoryBlockedReason = useMemo(
    () =>
      refs
        .flatMap((ref) => ref.blocked)
        .find(
          (reason) => reason.operation === operationTag && REPOSITORY_BLOCK_CODES.has(reason.code),
        ) ?? null,
    [operationTag, refs],
  );
  const blockedReason = intoOtherBranch
    ? (refs
        .find((ref) => ref.name === target)
        ?.blocked.find((reason) => reason.operation === "merge-into") ?? null)
    : selectedOption === null
      ? null
      : selectedOption.remote
        ? repositoryBlockedReason
        : (selectedOption.entry.blocked.find((reason) => reason.operation === operationTag) ??
          null);

  const previewAtom = useMemo(
    () =>
      !open || selectedSource === null || capabilityDisabledReason !== null
        ? null
        : gitManagerEnvironment.previewMerge({
            environmentId,
            input: {
              cwd,
              source: selectedSource,
              ...(intoOtherBranch && target !== null ? { target } : {}),
            },
          }),
    [capabilityDisabledReason, cwd, environmentId, intoOtherBranch, open, selectedSource, target],
  );
  const previewQuery = useEnvironmentQuery(previewAtom);
  // A cached preview for another source or target must not enable Merge.
  const preview =
    previewQuery.data !== null &&
    previewQuery.data.source === selectedSource &&
    (!intoOtherBranch || previewQuery.data.current === target)
      ? previewQuery.data
      : null;
  const summary = preview === null ? null : summarizeMergePreview(preview, { intoOtherBranch });
  const copy = resolveMergeConfirmCopy(effectiveMode, intoOtherBranch ? target : null);
  // Below Git 2.38 there is no preview, but merging into the checked-out branch still works.
  const previewUnsupported =
    !intoOtherBranch && previewQuery.error?.startsWith(MERGE_PREVIEW_GIT_TOO_OLD_PREFIX) === true;
  const disabledReason =
    capabilityDisabledReason ??
    blockedReason?.message ??
    (operationRunning
      ? "The selected Git operation is running."
      : selectedSource === null
        ? "Choose a source branch."
        : previewUnsupported
          ? null
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
  const chooseTarget = useCallback((name: string | null) => {
    if (name === null) return;
    setTargetName(name);
    setSelectedSourceRef((current) => (current === `refs/heads/${name}` ? null : current));
  }, []);
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
    const input: GitManagerOperationRequest =
      operationTag === "merge-into" && target !== null
        ? {
            _tag: "merge-into",
            cwd,
            projectId: projectRef.projectId,
            source: selectedSource,
            target,
          }
        : {
            _tag: operationTag === "squash-merge" ? "squash-merge" : "merge",
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
    target,
  ]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>
            Select a source branch and review the server-computed merge preview.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-3 px-6 pb-4">
          {showTargetPicker ? (
            <div className="space-y-1.5">
              <label className="block text-sm" htmlFor="git-manager-merge-target">
                Into
              </label>
              <Combobox
                items={targetNames}
                value={target}
                onValueChange={chooseTarget}
                disabled={operationRunning}
              >
                <ComboboxInput
                  className="font-mono"
                  id="git-manager-merge-target"
                  placeholder="Search branches…"
                />
                <ComboboxPopup data-text-surface="popover">
                  <ComboboxEmpty>No matching branches.</ComboboxEmpty>
                  <ComboboxList>
                    {(name: string) => (
                      <ComboboxItem className="font-mono" key={name} value={name}>
                        {name}
                      </ComboboxItem>
                    )}
                  </ComboboxList>
                </ComboboxPopup>
              </Combobox>
              {intoOtherBranch ? (
                <p className="text-xs text-muted-foreground">
                  `{target}` is updated without checking it out. Your files don't change and commit
                  hooks don't run.
                </p>
              ) : null}
            </div>
          ) : null}
          <div className="flex gap-2" role="group" aria-label="Merge mode">
            <Button
              aria-pressed={effectiveMode === "merge"}
              className={MERGE_MODE_BUTTON_CLASS}
              size="sm"
              variant="outline"
              onClick={chooseMerge}
            >
              Merge commit
            </Button>
            {intoOtherBranch ? null : (
              <Button
                aria-pressed={effectiveMode === "squash"}
                className={MERGE_MODE_BUTTON_CLASS}
                size="sm"
                variant="outline"
                onClick={chooseSquash}
              >
                Squash merge
              </Button>
            )}
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
            {localSourceOptions.length === 0 && remoteSourceOptions.length === 0 ? (
              <p className="p-3 text-xs text-muted-foreground">No source branches found.</p>
            ) : (
              <>
                {localSourceOptions.map((option) => (
                  <MergeSourceButton
                    key={option.ref}
                    option={option}
                    selected={option.ref === selectedSource}
                    onSelect={setSelectedSourceRef}
                  />
                ))}
                {remoteSourceOptions.length === 0 ? null : (
                  <>
                    <p className="px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground uppercase">
                      Remote
                    </p>
                    {remoteSourceOptions.map((option) => (
                      <MergeSourceButton
                        key={option.ref}
                        option={option}
                        selected={option.ref === selectedSource}
                        onSelect={setSelectedSourceRef}
                      />
                    ))}
                  </>
                )}
              </>
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
                <p className="mt-1 text-xs text-muted-foreground">
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
