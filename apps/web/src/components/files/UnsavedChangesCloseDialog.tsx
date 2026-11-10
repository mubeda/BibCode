import { useEffect, useRef, useSyncExternalStore } from "react";

import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  attachLeaveQuestionHost,
  getLeaveQuestion,
  subscribeLeaveQuestion,
} from "./unsavedFileEdits";

export interface UnsavedChangesCloseDialogProps {
  files: readonly string[];
  onSaveAll(): void;
  onDiscard(): void;
  onCancel(): void;
}

export function UnsavedChangesCloseDialog({
  files,
  onSaveAll,
  onDiscard,
  onCancel,
}: UnsavedChangesCloseDialogProps) {
  const saveAllRef = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogPopup initialFocus={saveAllRef}>
        <AlertDialogHeader>
          <AlertDialogTitle>Save your changes before leaving?</AlertDialogTitle>
          <AlertDialogDescription>
            {files.length === 1
              ? "This file has changes that are not saved. Discard loses them."
              : `These ${files.length} files have changes that are not saved. Discard loses them.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="max-h-48 overflow-y-auto px-6 pb-4 font-mono text-sm">
          {files.map((file) => (
            <li key={file} className="truncate" title={file}>
              {file}
            </li>
          ))}
        </ul>
        <AlertDialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive-outline" onClick={onDiscard}>
            Discard
          </Button>
          <Button ref={saveAllRef} onClick={onSaveAll}>
            Save all
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

/** The window's one place that shows the leave question. Mount it once on every route. */
export function UnsavedChangesCloseHost() {
  const question = useSyncExternalStore(subscribeLeaveQuestion, getLeaveQuestion, getLeaveQuestion);
  useEffect(() => attachLeaveQuestionHost(), []);
  if (question === null) return null;
  return (
    <UnsavedChangesCloseDialog
      files={question.files}
      onSaveAll={() => question.answer("save")}
      onDiscard={() => question.answer("discard")}
      onCancel={() => question.answer("cancel")}
    />
  );
}
