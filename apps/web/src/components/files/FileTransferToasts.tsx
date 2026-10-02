import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { FileTransferOperation } from "@bibcode/client-runtime/state/file-transfers";
import { EnvironmentId } from "@bibcode/contracts";
import { useContext, useEffect, useMemo, useRef } from "react";
import { fileTransfers } from "~/state/fileTransfers";
import { toastManager } from "../ui/toast";
import { saveBrowserDownload } from "./fileTransfers";
import {
  createFileTransferToastController,
  transferProgressCopy,
  type TransferToastState,
} from "./transferPresentation";
const environmentKeys = (operations: ReadonlyMap<EnvironmentId, FileTransferOperation>): string =>
  JSON.stringify([...operations.keys()].sort());
const presentationKey = (value: FileTransferOperation | null): string => {
  if (value === null) return "";
  const detail =
    value.phase === "ready"
      ? value.result.fileName
      : value.phase === "saved"
        ? value.path
        : value.phase === "failed"
          ? value.message
          : transferProgressCopy(value.progress);
  return `${value.operationId}\n${value.phase}\n${value.route}\n${value.cancellable}\n${value.fileName}\n${detail}`;
};
function EnvironmentTransferToast({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const registry = useContext(RegistryContext);
  const signature = useAtomValue(fileTransfers.operation(environmentId), presentationKey);
  const controller = useRef<ReturnType<typeof createFileTransferToastController> | null>(null);
  useEffect(() => {
    const read = (): TransferToastState | null => {
      const value = registry.get(fileTransfers.operation(environmentId));
      if (value === null) return null;
      const operationId = value.operationId;
      const cancel = () => fileTransfers.cancel(registry, environmentId, operationId);
      const discard = () => fileTransfers.dismiss(registry, environmentId, operationId);
      switch (value.phase) {
        case "ready":
          return {
            phase: "ready",
            operationId,
            fileName: value.result.fileName,
            save: () => saveBrowserDownload(value.result),
            discard,
          };
        case "saved":
          return { phase: "saved", operationId, path: value.path, discard };
        // The existing Files presenter owns HTTP and admission errors. Encrypted read failures
        // live here so their outcome remains visible after the initiating panel unmounts.
        case "failed":
          return value.route === "in-channel"
            ? {
                phase: "failed",
                operationId,
                fileName: value.fileName,
                message: value.message,
                discard,
              }
            : null;
        case "finishing":
          return { phase: "finishing", operationId, fileName: value.fileName };
        case "cancelling":
          return { phase: "cancelling", operationId, fileName: value.fileName };
        case "preparing":
          return { phase: "preparing", operationId, fileName: value.fileName, cancel };
        case "running":
        case "reconnecting":
          return value.route === "http" && !value.cancellable
            ? { phase: "http", operationId, fileName: value.fileName }
            : { phase: "running", operationId, progress: value.progress, cancel };
      }
    };
    const owned = createFileTransferToastController(toastManager, read);
    controller.current = owned;
    owned.sync();
    return () => {
      owned.dispose();
      if (controller.current === owned) controller.current = null;
    };
  }, [environmentId, registry]);
  useEffect(() => {
    // The selected scalar is the notification; controller.sync reads the latest full projection.
    if (signature !== "") controller.current?.sync();
  }, [signature]);
  return null;
}
/** The operation map, rather than the current catalog, retains finalizing removed environments. */
export function FileTransferToasts() {
  const keys = useAtomValue(fileTransfers.operations, environmentKeys);
  const ids = useMemo(
    () => (JSON.parse(keys) as string[]).map((id) => EnvironmentId.make(id)),
    [keys],
  );
  return ids.map((id) => <EnvironmentTransferToast key={id} environmentId={id} />);
}
