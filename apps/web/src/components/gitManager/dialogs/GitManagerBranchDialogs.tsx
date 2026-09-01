import type { GitManagerRefEntry } from "@bibcode/contracts";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

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

export type GitManagerBranchDialog =
  | { readonly kind: "create"; readonly baseBranch: string | null }
  | { readonly kind: "rename"; readonly branch: GitManagerRefEntry }
  | {
      readonly kind: "delete";
      readonly branch: GitManagerRefEntry;
      readonly existsUpstream: boolean;
    };

export type GitManagerBranchDialogSubmission =
  | { readonly kind: "create"; readonly name: string; readonly startPoint: string | null }
  | { readonly kind: "rename"; readonly name: string; readonly newName: string }
  | { readonly kind: "delete"; readonly name: string; readonly deleteRemote: boolean };

export interface GitManagerBranchDialogsProps {
  readonly dialog: GitManagerBranchDialog | null;
  readonly refs: ReadonlyArray<GitManagerRefEntry>;
  readonly busy: boolean;
  readonly errorMessage: string | null;
  readonly disabledReason?: string | null;
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
  readonly onClose: () => void;
  readonly onSubmit: (submission: GitManagerBranchDialogSubmission) => Promise<void>;
}

function DialogError({ message }: { readonly message: string | null }) {
  return message === null ? null : (
    <p aria-live="polite" className="text-sm text-destructive">
      {message}
    </p>
  );
}

function CreateBranchDialog({
  baseBranch,
  refs,
  busy,
  errorMessage,
  disabledReason: capabilityDisabledReason,
  onClose,
  onSubmit,
}: SharedDialogProps & { readonly baseBranch: string | null }) {
  const [name, setName] = useState("");
  const [debouncedRulesMessage, setDebouncedRulesMessage] = useState<string | null>(null);
  const trimmedName = name.trim();
  const duplicate = useMemo(
    () => refs.some((ref) => ref.name.toLocaleLowerCase() === trimmedName.toLocaleLowerCase()),
    [refs, trimmedName],
  );
  useEffect(() => {
    if (trimmedName.length === 0) {
      setDebouncedRulesMessage(null);
      return;
    }
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
  const disabledReasonId =
    disabledReason === null ? undefined : "git-manager-create-branch-disabled-reason";
  const submit = useCallback(() => {
    if (disabledReason !== null) return;
    void onSubmit({ kind: "create", name: trimmedName, startPoint: baseBranch });
  }, [baseBranch, disabledReason, onSubmit, trimmedName]);

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>New Branch</DialogTitle>
          <DialogDescription>
            Create and check out a local branch from {baseBranch ?? "the current HEAD"}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-6 pb-4">
          <label className="block space-y-1 text-sm">
            <span>Branch name</span>
            <Input
              autoFocus
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </label>
          {disabledReason === null ? null : (
            <p className="text-xs text-muted-foreground" id={disabledReasonId}>
              {disabledReason}
            </p>
          )}
          <DialogError message={errorMessage} />
        </div>
        <DialogFooter>
          <Button disabled={busy} variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            aria-describedby={disabledReasonId}
            disabled={busy || disabledReason !== null}
            title={capabilityDisabledReason ?? undefined}
            onClick={submit}
          >
            Create branch
          </Button>
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
  onClose,
  onSubmit,
}: SharedDialogProps & { readonly branch: GitManagerRefEntry }) {
  const [name, setName] = useState(branch.name);
  const trimmedName = name.trim();
  const serverBlock =
    branch.blocked.find((reason) => reason.operation === "branch-rename") ??
    branch.blocked[0] ??
    null;
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
  const descriptionId =
    disabledReason === null ? undefined : "git-manager-rename-branch-disabled-reason";
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
          {disabledReason === null ? null : (
            <p
              className={
                serverBlock === null && capabilityDisabledReason === null
                  ? "text-xs text-muted-foreground"
                  : "text-sm text-destructive"
              }
              id={descriptionId}
            >
              {disabledReason}
            </p>
          )}
          <DialogError message={errorMessage} />
        </div>
        <DialogFooter>
          <Button disabled={busy} variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            aria-describedby={descriptionId}
            disabled={busy || disabledReason !== null || trimmedName === branch.name}
            title={capabilityDisabledReason ?? serverBlock?.message}
            onClick={submit}
          >
            Rename
          </Button>
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
  disabledReason: capabilityDisabledReason,
  onClose,
  onSubmit,
}: Omit<SharedDialogProps, "refs"> & {
  readonly branch: GitManagerRefEntry;
  readonly existsUpstream: boolean;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [deleteRemote, setDeleteRemote] = useState(false);
  const serverBlock = branch.blocked.find((reason) => reason.operation === "branch-delete") ?? null;
  const disabledReason = capabilityDisabledReason ?? serverBlock?.message ?? null;
  const descriptionId =
    disabledReason === null ? undefined : "git-manager-delete-branch-disabled-reason";
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
          {disabledReason === null ? null : (
            <p className="text-destructive" id={descriptionId}>
              {disabledReason}
            </p>
          )}
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
          <DialogError message={errorMessage} />
        </div>
        <DialogFooter>
          <Button disabled={busy} variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            aria-describedby={descriptionId}
            disabled={busy || !confirmed || disabledReason !== null}
            title={disabledReason ?? undefined}
            variant="destructive"
            onClick={submit}
          >
            Delete branch
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export const GitManagerBranchDialogs = memo(function GitManagerBranchDialogs({
  dialog,
  refs,
  busy,
  errorMessage,
  disabledReason = null,
  onClose,
  onSubmit,
}: GitManagerBranchDialogsProps) {
  if (dialog === null) return null;
  const shared = { refs, busy, disabledReason, errorMessage, onClose, onSubmit };
  switch (dialog.kind) {
    case "create":
      return <CreateBranchDialog key="create" {...shared} baseBranch={dialog.baseBranch} />;
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
          onClose={onClose}
          onSubmit={onSubmit}
        />
      );
  }
});
