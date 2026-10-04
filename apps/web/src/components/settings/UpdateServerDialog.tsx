import type { RemoteUpdateConfirmationRequest } from "~/state/remoteUpdates";
import { remoteUpdateEnvironment } from "~/state/remoteUpdates";
import { useEnvironmentQuery } from "~/state/query";
import { APP_VERSION } from "~/branding";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useCallback, useContext } from "react";
import { remoteUpdateConfirmationRequest, useStartRemoteUpdate } from "~/state/remoteUpdates";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { remoteUpdateConfirmation } from "./remoteUpdatePresentation";

export type UpdateServerRequest = RemoteUpdateConfirmationRequest;
export interface UpdateServerDialogProps {
  readonly request: UpdateServerRequest | null;
  readonly onClose: () => void;
  readonly onConfirm: (request: UpdateServerRequest) => void;
}

/** One confirmation owner for Settings, sidebar actions, and Retry toasts. */
export function RemoteUpdateConfirmationCoordinator() {
  const registry = useContext(RegistryContext);
  const request = useAtomValue(remoteUpdateConfirmationRequest);
  const start = useStartRemoteUpdate();
  const close = useCallback(() => registry.set(remoteUpdateConfirmationRequest, null), [registry]);
  return <UpdateServerDialog request={request} onClose={close} onConfirm={start} />;
}

export function UpdateServerDialog(props: UpdateServerDialogProps) {
  return props.request === null ? null : (
    <UpdateServerDialogBody key={props.request.environmentId} {...props} request={props.request} />
  );
}

function UpdateServerDialogBody({
  request,
  onClose,
  onConfirm,
}: UpdateServerDialogProps & { readonly request: UpdateServerRequest }) {
  const work = useEnvironmentQuery(
    request.progress
      ? remoteUpdateEnvironment.activeWork({ environmentId: request.environmentId, input: {} })
      : null,
  );
  const confirmation = remoteUpdateConfirmation({
    name: request.name,
    targetVersion: request.targetVersion,
    activeWork: request.progress && work.error === null ? work.data : null,
    counting: request.progress && work.isPending && work.data === null,
    appVersion: APP_VERSION,
  });
  const [first, ...remaining] = confirmation.lines;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{confirmation.title}</DialogTitle>
          <DialogDescription>{first}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div data-text-surface="background" className="grid gap-2 bg-background text-sm">
            {remaining.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              onConfirm(request);
              onClose();
            }}
          >
            {confirmation.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
