import type { EnvironmentId } from "@bibcode/contracts";

import { RemoteDirectoryBrowser } from "../RemoteDirectoryBrowser";
import { Dialog, DialogDescription, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";

export interface RemoteDirectoryPickerDialogProps {
  readonly open: boolean;
  readonly environmentId: EnvironmentId;
  readonly initialPath: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelect: (path: string) => void;
}

export function RemoteDirectoryPickerDialog({
  open,
  environmentId,
  initialPath,
  onOpenChange,
  onSelect,
}: RemoteDirectoryPickerDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader className="pb-4">
          <DialogTitle>Select Workspace folder</DialogTitle>
          <DialogDescription>Browse directories on the selected BiBCode host.</DialogDescription>
        </DialogHeader>
        <div className="px-6 pb-5">
          {open ? (
            <RemoteDirectoryBrowser
              environmentId={environmentId}
              initialPath={initialPath}
              resetKey={open}
              onSelect={onSelect}
              onCancel={() => onOpenChange(false)}
            />
          ) : null}
        </div>
      </DialogPopup>
    </Dialog>
  );
}
