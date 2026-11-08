import type { CheckpointRevertMode } from "@bibcode/contracts";
import { memo } from "react";

import { Button } from "../ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { RESTORED_PATHS_SHOWN, type RevertDialogModel } from "./RevertCheckpointDialog.logic";

/** "Revert to this message" (#279): named choices instead of the native two-button confirm. */
export const RevertCheckpointDialog = memo(function RevertCheckpointDialog(props: {
  readonly model: RevertDialogModel | null;
  readonly onChoose: (mode: CheckpointRevertMode) => void;
  readonly onDismiss: () => void;
}) {
  const { model, onChoose, onDismiss } = props;
  const shown = model?.restoredPaths.slice(0, RESTORED_PATHS_SHOWN) ?? [];
  const hidden = model?.restoredPaths.slice(RESTORED_PATHS_SHOWN) ?? [];
  return (
    <AlertDialog
      open={model !== null}
      onOpenChange={(open) => {
        if (!open) onDismiss();
      }}
    >
      {model !== null && (
        <AlertDialogPopup data-testid="revert-checkpoint-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{model.title}</AlertDialogTitle>
            <AlertDialogDescription>{model.description}</AlertDialogDescription>
            {model.outsideChanges.length > 0 && (
              <div className="text-sm text-muted-foreground">
                <p>Files changed outside this chat since then. Reverting files undoes these too:</p>
                <ul className="mt-1 list-disc ps-5">
                  {model.outsideChanges.map((line) => (
                    <li key={line} className="break-words">
                      {line}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {model.restoredPaths.length > 0 && (
              <div className="text-sm text-muted-foreground">
                <p>Files this revert restores:</p>
                <ul className="mt-1 list-disc ps-5 font-mono text-xs">
                  {shown.map((path) => (
                    <li key={path} className="break-all">
                      {path}
                    </li>
                  ))}
                </ul>
                {hidden.length > 0 && (
                  <details className="mt-1">
                    <summary className="cursor-pointer">and {hidden.length} more</summary>
                    <ul className="mt-1 list-disc ps-5 font-mono text-xs">
                      {hidden.map((path) => (
                        <li key={path} className="break-all">
                          {path}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              {model.dismissLabel}
            </AlertDialogClose>
            {model.actions.toReversed().map((action) => (
              <Button
                key={action.mode}
                variant={
                  action.destructive ? "destructive" : action.primary ? "default" : "outline"
                }
                onClick={() => onChoose(action.mode)}
              >
                {action.label}
              </Button>
            ))}
          </AlertDialogFooter>
        </AlertDialogPopup>
      )}
    </AlertDialog>
  );
});
