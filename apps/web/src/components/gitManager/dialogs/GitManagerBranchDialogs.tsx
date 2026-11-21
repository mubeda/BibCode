import type { GitManagerRefEntry } from "@bibcode/contracts";
import { memo, type ReactNode, useCallback, useEffect, useId, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Combobox,
  ComboboxCollection,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxGroupLabel,
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
import { GitManagerDisabledReasonButton } from "../GitManagerDisabledReasonButton";
import { GUARD_DELETE_BRANCH, GUARD_RENAME_BRANCH } from "../gitManagerGuardOperations";
import { remoteDeleteBlockedReason } from "../toolbar/remoteBranchRef";

export type GitManagerBranchDialog =
  | {
      readonly kind: "create";
      /** The checked-out branch; null when HEAD is detached or a commit is the base. */
      readonly baseBranch: string | null;
      /** A commit chosen in History; it becomes the default source. */
      readonly baseCommit: string | null;
      /** HEAD names a branch with no commit yet, so Git can create a branch only by switching. */
      readonly unborn?: boolean;
    }
  | { readonly kind: "rename"; readonly branch: GitManagerRefEntry }
  | {
      readonly kind: "delete";
      readonly branch: GitManagerRefEntry;
      readonly existsUpstream: boolean;
    }
  | {
      readonly kind: "delete-remote";
      /** The remote-tracking row, named `<remote>/<branch>`. */
      readonly branch: GitManagerRefEntry;
      readonly remote: string;
      readonly remoteBranch: string;
    };

export type GitManagerBranchDialogSubmission =
  | {
      readonly kind: "create";
      readonly name: string;
      /** A full ref (`refs/heads/…`, `refs/remotes/…`), a commit SHA, or null for HEAD. */
      readonly startPoint: string | null;
      readonly checkout: boolean;
    }
  | { readonly kind: "rename"; readonly name: string; readonly newName: string }
  | { readonly kind: "delete"; readonly name: string; readonly deleteRemote: boolean }
  | { readonly kind: "delete-remote"; readonly remote: string; readonly branch: string };

export interface GitManagerBranchDialogsProps {
  readonly dialog: GitManagerBranchDialog | null;
  readonly refs: ReadonlyArray<GitManagerRefEntry>;
  /** Remote-tracking branches, named `<remote>/<branch>`; offered as New Branch sources. */
  readonly remoteRefs: ReadonlyArray<GitManagerRefEntry>;
  readonly busy: boolean;
  readonly errorMessage: string | null;
  readonly disabledReason?: string | null;
  /** A Git sign-in prompt for the request this dialog sent; shown inside the modal dialog. */
  readonly signInPrompt?: ReactNode;
  readonly onClose: () => void;
  readonly onSubmit: (submission: GitManagerBranchDialogSubmission) => Promise<void>;
}

function refRulesMessage(name: string): string | null {
  if (name.startsWith("-") || name.endsWith(".") || name.endsWith("/") || name.includes("..")) {
    return "Enter a valid Git branch name.";
  }
  if (
    /\s/u.test(name) ||
    ["~", "^", ":", "?", "*", "[", "\\"].some((character) => name.includes(character)) ||
    name.includes("//") ||
    name.includes("@{")
  ) {
    return "Enter a valid Git branch name.";
  }
  return null;
}

interface SharedDialogProps {
  readonly refs: ReadonlyArray<GitManagerRefEntry>;
  readonly busy: boolean;
  readonly errorMessage: string | null;
  readonly disabledReason: string | null;
  /**
   * A pending Git sign-in. While it shows, it replaces the dialog's error and its own disabled
   * reason (UI.md: one message at a time); the submit stays disabled with that reason.
   */
  readonly signInPrompt: ReactNode;
  readonly onClose: () => void;
  readonly onSubmit: (submission: GitManagerBranchDialogSubmission) => Promise<void>;
}

function DialogError({ message }: { readonly message: string | null }) {
  return message === null ? null : (
    <p aria-live="polite" className="text-sm whitespace-pre-wrap text-destructive">
      {message}
    </p>
  );
}

interface BranchSourceOption {
  readonly key: string;
  readonly label: string;
  readonly startPoint: string | null;
}

interface BranchSourceGroup {
  readonly value: string;
  readonly items: ReadonlyArray<BranchSourceOption>;
}

function commitSource(sha: string): BranchSourceOption {
  return { key: `commit:${sha}`, label: `Commit ${sha.slice(0, 7)}`, startPoint: sha };
}

const HEAD_SOURCE: BranchSourceOption = { key: "head", label: "Current HEAD", startPoint: null };

function localSource(name: string): BranchSourceOption {
  return { key: `local:${name}`, label: name, startPoint: `refs/heads/${name}` };
}

function remoteSource(name: string): BranchSourceOption {
  return { key: `remote:${name}`, label: name, startPoint: `refs/remotes/${name}` };
}

function initialBranchSource(baseBranch: string | null, baseCommit: string | null) {
  if (baseCommit !== null) return commitSource(baseCommit);
  return baseBranch === null ? HEAD_SOURCE : localSource(baseBranch);
}

function CreateBranchDialog({
  baseBranch,
  baseCommit,
  unborn,
  refs,
  remoteRefs,
  busy,
  errorMessage,
  disabledReason: capabilityDisabledReason,
  signInPrompt,
  onClose,
  onSubmit,
}: SharedDialogProps & {
  readonly baseBranch: string | null;
  readonly baseCommit: string | null;
  readonly unborn: boolean;
  readonly remoteRefs: ReadonlyArray<GitManagerRefEntry>;
}) {
  const [name, setName] = useState("");
  const [source, setSource] = useState(() => initialBranchSource(baseBranch, baseCommit));
  const [checkoutChoice, setCheckout] = useState(true);
  // Only the unborn HEAD itself has no ref to start from, so only it must be switched to.
  const checkoutForced = unborn && source.startPoint === null;
  const checkout = checkoutForced || checkoutChoice;
  const [debouncedRulesMessage, setDebouncedRulesMessage] = useState<string | null>(null);
  const checkoutHintId = useId();
  const trimmedName = name.trim();
  const currentBranch = useMemo(() => refs.find((branch) => branch.current)?.name ?? null, [refs]);
  const sourceGroups = useMemo((): ReadonlyArray<BranchSourceGroup> => {
    const start =
      baseCommit !== null ? [commitSource(baseCommit)] : baseBranch === null ? [HEAD_SOURCE] : [];
    return [
      { value: "Start point", items: start },
      { value: "Local", items: refs.map((ref) => localSource(ref.name)) },
      { value: "Remote", items: remoteRefs.map((ref) => remoteSource(ref.name)) },
    ].filter((group) => group.items.length > 0);
  }, [baseBranch, baseCommit, refs, remoteRefs]);
  const duplicate = useMemo(
    () => refs.some((ref) => ref.name.toLocaleLowerCase() === trimmedName.toLocaleLowerCase()),
    [refs, trimmedName],
  );
  useEffect(() => {
    if (trimmedName.length === 0) return;
    const timer = window.setTimeout(
      () => setDebouncedRulesMessage(refRulesMessage(trimmedName)),
      250,
    );
    return () => window.clearTimeout(timer);
  }, [trimmedName]);
  const validationMessage =
    trimmedName.length === 0
      ? "Branch name is required."
      : duplicate
        ? `A branch named ${trimmedName} already exists.`
        : debouncedRulesMessage;
  const disabledReason = capabilityDisabledReason ?? validationMessage;
  const shownReason = signInPrompt === null ? disabledReason : validationMessage;
  const disabledReasonId =
    shownReason === null ? undefined : "git-manager-create-branch-disabled-reason";
  const submit = useCallback(() => {
    if (disabledReason !== null) return;
    void onSubmit({ kind: "create", name: trimmedName, startPoint: source.startPoint, checkout });
  }, [checkout, disabledReason, onSubmit, source.startPoint, trimmedName]);

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>New Branch</DialogTitle>
          <DialogDescription>Creates a local branch from the selected source.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 px-6 pb-4">
          <div className="space-y-1.5">
            <label className="block space-y-1 text-sm" htmlFor="git-manager-create-branch-name">
              Branch name
            </label>
            <Input
              autoFocus
              aria-describedby={disabledReasonId}
              id="git-manager-create-branch-name"
              value={name}
              onChange={(event) => {
                const next = event.currentTarget.value;
                setName(next);
                // Clearing the name drops the debounced message so retyping never shows a stale one.
                if (next.trim().length === 0) setDebouncedRulesMessage(null);
              }}
            />
            {shownReason === null ? null : (
              <p className="text-xs text-muted-foreground" id={disabledReasonId}>
                {shownReason}
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <label className="block text-sm" htmlFor="git-manager-create-branch-source">
              From
            </label>
            <Combobox
              items={sourceGroups}
              value={source}
              itemToStringLabel={(option: BranchSourceOption) => option.label}
              isItemEqualToValue={(option: BranchSourceOption, value: BranchSourceOption) =>
                option.key === value.key
              }
              onValueChange={(option: BranchSourceOption | null) => {
                if (option !== null) setSource(option);
              }}
              disabled={busy}
            >
              <ComboboxInput
                className="font-mono"
                id="git-manager-create-branch-source"
                placeholder="Search branches…"
              />
              <ComboboxPopup data-text-surface="popover">
                <ComboboxEmpty>No matching branches.</ComboboxEmpty>
                <ComboboxList>
                  {(group: BranchSourceGroup) => (
                    <ComboboxGroup items={group.items as BranchSourceOption[]} key={group.value}>
                      <ComboboxGroupLabel>{group.value}</ComboboxGroupLabel>
                      <ComboboxCollection>
                        {(option: BranchSourceOption) => (
                          <ComboboxItem className="font-mono" key={option.key} value={option}>
                            {option.label}
                          </ComboboxItem>
                        )}
                      </ComboboxCollection>
                    </ComboboxGroup>
                  )}
                </ComboboxList>
              </ComboboxPopup>
            </Combobox>
          </div>
          <div className="space-y-0.5">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                aria-describedby={checkoutHintId}
                checked={checkout}
                data-testid="git-manager-create-branch-checkout"
                disabled={busy || checkoutForced}
                onCheckedChange={setCheckout}
              />
              Check out after creating
            </label>
            <p className="ps-6 text-xs text-muted-foreground" id={checkoutHintId}>
              {checkoutForced
                ? "No commit exists yet, so the new branch can only start by switching to it."
                : checkout
                  ? "Switches this checkout to the new branch."
                  : currentBranch === null
                    ? "You stay on the current commit."
                    : `You stay on ${currentBranch}.`}
            </p>
          </div>
          {signInPrompt === null ? <DialogError message={errorMessage} /> : signInPrompt}
        </div>
        <DialogFooter>
          <Button disabled={busy} variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <GitManagerDisabledReasonButton
            // The component describes a capability reason itself; a name problem is described here.
            aria-describedby={capabilityDisabledReason === null ? disabledReasonId : undefined}
            disabled={busy || disabledReason !== null}
            disabledReason={capabilityDisabledReason}
            onClick={submit}
          >
            {checkout ? "Create and check out" : "Create branch"}
          </GitManagerDisabledReasonButton>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function RenameBranchDialog({
  branch,
  refs,
  busy,
  errorMessage,
  disabledReason: capabilityDisabledReason,
  signInPrompt,
  onClose,
  onSubmit,
}: SharedDialogProps & { readonly branch: GitManagerRefEntry }) {
  const [name, setName] = useState(branch.name);
  const trimmedName = name.trim();
  const serverBlock =
    branch.blocked.find((reason) => reason.operation === GUARD_RENAME_BRANCH) ?? null;
  const duplicate = refs.some(
    (ref) =>
      ref.name !== branch.name && ref.name.toLocaleLowerCase() === trimmedName.toLocaleLowerCase(),
  );
  const localMessage =
    trimmedName.length === 0
      ? "Branch name is required."
      : duplicate
        ? `A branch named ${trimmedName} already exists.`
        : refRulesMessage(trimmedName);
  const disabledReason = capabilityDisabledReason ?? serverBlock?.message ?? localMessage;
  const shownReason =
    signInPrompt === null ? disabledReason : (serverBlock?.message ?? localMessage);
  const descriptionId =
    shownReason === null ? undefined : "git-manager-rename-branch-disabled-reason";
  const submit = useCallback(() => {
    if (disabledReason !== null) return;
    void onSubmit({ kind: "rename", name: branch.name, newName: trimmedName });
  }, [branch.name, disabledReason, onSubmit, trimmedName]);

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Rename Branch</DialogTitle>
          <DialogDescription>Rename {branch.name}. No remote branch is renamed.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-6 pb-4">
          <Input
            autoFocus
            aria-label="New branch name"
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
          />
          {shownReason === null ? null : (
            <p
              className={
                serverBlock === null && capabilityDisabledReason === null
                  ? "text-xs text-muted-foreground"
                  : "text-sm text-destructive"
              }
              id={descriptionId}
            >
              {shownReason}
            </p>
          )}
          {signInPrompt === null ? <DialogError message={errorMessage} /> : signInPrompt}
        </div>
        <DialogFooter>
          <Button disabled={busy} variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <GitManagerDisabledReasonButton
            aria-describedby={
              capabilityDisabledReason === null && serverBlock === null ? descriptionId : undefined
            }
            disabled={busy || disabledReason !== null || trimmedName === branch.name}
            disabledReason={capabilityDisabledReason ?? serverBlock?.message ?? null}
            onClick={submit}
          >
            Rename
          </GitManagerDisabledReasonButton>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function DeleteBranchDialog({
  branch,
  existsUpstream,
  busy,
  errorMessage,
  signInPrompt,
  disabledReason: capabilityDisabledReason,
  onClose,
  onSubmit,
}: Omit<SharedDialogProps, "refs"> & {
  readonly branch: GitManagerRefEntry;
  readonly existsUpstream: boolean;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [deleteRemote, setDeleteRemote] = useState(false);
  const serverBlock =
    branch.blocked.find((reason) => reason.operation === GUARD_DELETE_BRANCH) ?? null;
  const disabledReason = capabilityDisabledReason ?? serverBlock?.message ?? null;
  const shownReason = signInPrompt === null ? disabledReason : (serverBlock?.message ?? null);
  const submit = useCallback(() => {
    if (!confirmed || disabledReason !== null) return;
    void onSubmit({ kind: "delete", name: branch.name, deleteRemote });
  }, [branch.name, confirmed, deleteRemote, disabledReason, onSubmit]);

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Delete Branch?</DialogTitle>
          <DialogDescription>
            Delete the local branch {branch.name}. This cannot be undone and does not delete any
            commits reachable from another ref.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-6 pb-4 text-sm">
          {shownReason === null ? null : <p className="text-destructive">{shownReason}</p>}
          <label className="flex items-start gap-2">
            <input
              checked={confirmed}
              className="mt-1"
              name="confirm-delete"
              type="checkbox"
              onChange={(event) => setConfirmed(event.currentTarget.checked)}
            />
            <span>I understand that deleting this branch cannot be undone.</span>
          </label>
          {existsUpstream ? (
            <label className="flex items-start gap-2">
              <input
                checked={deleteRemote}
                className="mt-1"
                name="delete-remote"
                type="checkbox"
                onChange={(event) => setDeleteRemote(event.currentTarget.checked)}
              />
              <span>Also delete the branch from its remote.</span>
            </label>
          ) : null}
          {signInPrompt === null ? <DialogError message={errorMessage} /> : signInPrompt}
        </div>
        <DialogFooter>
          <Button disabled={busy} variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <GitManagerDisabledReasonButton
            disabled={busy || !confirmed}
            disabledReason={disabledReason}
            variant="destructive"
            onClick={submit}
          >
            Delete branch
          </GitManagerDisabledReasonButton>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function DeleteRemoteBranchDialog({
  branch,
  remote,
  remoteBranch,
  remoteRefs,
  busy,
  errorMessage,
  signInPrompt,
  disabledReason: capabilityDisabledReason,
  onClose,
  onSubmit,
}: Omit<SharedDialogProps, "refs"> & {
  readonly branch: GitManagerRefEntry;
  readonly remote: string;
  readonly remoteBranch: string;
  readonly remoteRefs: ReadonlyArray<GitManagerRefEntry>;
}) {
  const [confirmed, setConfirmed] = useState(false);
  // Read the row from the newest snapshot: it may be gone, or have become the remote's default.
  const liveRow = remoteRefs.find((ref) => ref.name === branch.name);
  const rowReason =
    liveRow === undefined
      ? "This remote branch no longer exists."
      : remoteDeleteBlockedReason(liveRow, { remote, branch: remoteBranch });
  const disabledReason = capabilityDisabledReason ?? rowReason;
  const shownReason = signInPrompt === null ? disabledReason : rowReason;
  const submit = useCallback(() => {
    if (!confirmed || disabledReason !== null) return;
    void onSubmit({ kind: "delete-remote", remote, branch: remoteBranch });
  }, [confirmed, disabledReason, onSubmit, remote, remoteBranch]);

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Delete Remote Branch?</DialogTitle>
          <DialogDescription>
            Delete <span className="font-mono">{remoteBranch}</span> on remote{" "}
            <span className="font-mono">{remote}</span>. A local branch with the same name is kept.
            Before deleting, BiBCode asks the remote for its default branch and refuses to delete
            it. The remote may refuse to delete a protected branch.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-6 pb-4 text-sm">
          {shownReason === null ? null : <p className="text-destructive">{shownReason}</p>}
          <label className="flex items-start gap-2">
            <input
              checked={confirmed}
              className="mt-1"
              name="confirm-delete"
              type="checkbox"
              onChange={(event) => setConfirmed(event.currentTarget.checked)}
            />
            <span>I understand that deleting this branch cannot be undone.</span>
          </label>
          {signInPrompt === null ? <DialogError message={errorMessage} /> : signInPrompt}
        </div>
        <DialogFooter>
          <Button disabled={busy} variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <GitManagerDisabledReasonButton
            disabled={busy || !confirmed}
            disabledReason={disabledReason}
            variant="destructive"
            onClick={submit}
          >
            Delete remote branch
          </GitManagerDisabledReasonButton>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export const GitManagerBranchDialogs = memo(function GitManagerBranchDialogs({
  dialog,
  refs,
  remoteRefs,
  busy,
  errorMessage,
  disabledReason = null,
  signInPrompt = null,
  onClose,
  onSubmit,
}: GitManagerBranchDialogsProps) {
  if (dialog === null) return null;
  const shared = { refs, busy, disabledReason, errorMessage, signInPrompt, onClose, onSubmit };
  switch (dialog.kind) {
    case "create":
      return (
        <CreateBranchDialog
          key="create"
          {...shared}
          baseBranch={dialog.baseBranch}
          baseCommit={dialog.baseCommit}
          unborn={dialog.unborn === true}
          remoteRefs={remoteRefs}
        />
      );
    case "rename":
      return <RenameBranchDialog key={dialog.branch.name} {...shared} branch={dialog.branch} />;
    case "delete":
      return (
        <DeleteBranchDialog
          key={dialog.branch.name}
          branch={dialog.branch}
          busy={busy}
          disabledReason={disabledReason}
          errorMessage={errorMessage}
          existsUpstream={dialog.existsUpstream}
          signInPrompt={signInPrompt}
          onClose={onClose}
          onSubmit={onSubmit}
        />
      );
    case "delete-remote":
      return (
        <DeleteRemoteBranchDialog
          key={`remote:${dialog.branch.name}`}
          branch={dialog.branch}
          busy={busy}
          disabledReason={disabledReason}
          errorMessage={errorMessage}
          remote={dialog.remote}
          remoteBranch={dialog.remoteBranch}
          remoteRefs={remoteRefs}
          signInPrompt={signInPrompt}
          onClose={onClose}
          onSubmit={onSubmit}
        />
      );
  }
});
