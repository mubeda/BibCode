import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import {
  attachLeaveQuestionHost,
  getLeaveQuestion,
  isUpdateInstalling,
  recheckUpdateInstall,
  respondToDesktopCloseRequests,
  subscribeLeaveQuestion,
  type LeaveReason,
} from "./unsavedFileEdits";

const TITLE: Record<LeaveReason, string> = {
  close: "Save your changes before leaving?",
  quit: "Save your changes before leaving?",
  restart: "Save your changes before restarting?",
  update: "Save your changes before updating?",
};

export interface UnsavedChangesCloseDialogProps {
  reason?: LeaveReason;
  files: readonly string[];
  /** Save all is running: every choice waits for it. */
  saving?: boolean;
  onSaveAll(): void;
  onDiscard(): void;
  onCancel(): void;
}

export function UnsavedChangesCloseDialog({
  reason = "close",
  files,
  saving = false,
  onSaveAll,
  onDiscard,
  onCancel,
}: UnsavedChangesCloseDialogProps) {
  const saveAllRef = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onCancel();
      }}
    >
      <AlertDialogPopup initialFocus={saveAllRef}>
        <AlertDialogHeader>
          <AlertDialogTitle>{TITLE[reason]}</AlertDialogTitle>
          <AlertDialogDescription>
            {files.length === 1
              ? "This file has changes that are not saved. Discard loses them."
              : `These ${files.length} files have changes that are not saved. Discard loses them.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul
          className="max-h-48 overflow-y-auto px-6 pb-4 font-mono text-sm"
          data-text-surface="popover"
        >
          {files.map((file) => (
            <li key={file} className="truncate" title={file}>
              {file}
            </li>
          ))}
        </ul>
        <AlertDialogFooter>
          <Button variant="outline" disabled={saving} onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive-outline" disabled={saving} onClick={onDiscard}>
            Discard
          </Button>
          <Button ref={saveAllRef} disabled={saving} onClick={onSaveAll}>
            {saving ? "Saving…" : "Save all"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

/** Shown while an allowed update install runs, so no edit is made that the restart would lose. */
function UpdateInstallingDialog() {
  const [checking, setChecking] = useState(false);
  const checkAgain = () => {
    setChecking(true);
    void recheckUpdateInstall().finally(() => setChecking(false));
  };
  return (
    <AlertDialog open>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Spinner className="size-4" aria-hidden />
            Installing an update
          </AlertDialogTitle>
          <AlertDialogDescription>
            Another device started this update. BiBCode restarts when it finishes, and you can work
            again after that. If it seems stuck, check again.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" disabled={checking} onClick={checkAgain}>
            {checking ? "Checking…" : "Check again"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

/** The window's one place that shows the leave question. Mount it once on every route. */
export function UnsavedChangesCloseHost() {
  const question = useSyncExternalStore(subscribeLeaveQuestion, getLeaveQuestion, getLeaveQuestion);
  const installing = useSyncExternalStore(
    subscribeLeaveQuestion,
    isUpdateInstalling,
    isUpdateInstalling,
  );
  useEffect(() => {
    const detach = attachLeaveQuestionHost();
    const bridge = window.desktopBridge;
    const stop = bridge ? respondToDesktopCloseRequests(bridge) : undefined;
    return () => {
      stop?.();
      detach();
    };
  }, []);
  if (question === null) return installing ? <UpdateInstallingDialog /> : null;
  return (
    <UnsavedChangesCloseDialog
      reason={question.reason}
      files={question.files}
      saving={question.saving}
      onSaveAll={() => question.answer("save")}
      onDiscard={() => question.answer("discard")}
      onCancel={() => question.answer("cancel")}
    />
  );
}
