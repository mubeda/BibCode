import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { FileTransferOperation } from "@bibcode/client-runtime/state/file-transfers";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@bibcode/client-runtime/state/runtime";
import type { EnvironmentId } from "@bibcode/contracts";
import { useCallback, useContext } from "react";
import {
  fileTransfers,
  noFileTransferAvailability,
  noFileTransferOperation,
} from "~/state/fileTransfers";
import { useAtomCommand } from "~/state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { entryName } from "./FileTreeContextMenu.logic";
import {
  browserDownloadSink,
  desktopDownloadSink,
  downloadWithBridge,
  streamingDownloadBridge,
  triggerBrowserDownload,
} from "./fileTransfers";
import { transferBusyCopy, transferUnavailableCopy } from "./transferPresentation";

export const UPDATE_DOWNLOAD_APP = "Update this app to save encrypted downloads";
const DISCONNECTED = "Not connected to this environment's server. Reconnect and try again.";
const busyReason = (value: FileTransferOperation | null): string | null =>
  value === null || value.phase === "failed" || value.phase === "saved"
    ? null
    : value.phase === "ready" || value.cancellable
      ? transferBusyCopy(value.phase)
      : "Wait for the current download to finish.";

/** Presentation and sinks only: the runtime owns admission, route and authority across awaits. */
export function useFileDownloads({
  environmentId,
  cwd,
  showMutationError,
  toasts = toastManager,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string;
  readonly showMutationError: (error: unknown, title: string) => void;
  readonly toasts?: Pick<typeof toastManager, "add">;
}) {
  const registry = useContext(RegistryContext);
  const availability = useAtomValue(
    environmentId === null ? noFileTransferAvailability : fileTransfers.availability(environmentId),
  );
  // A scalar subscription avoids rerendering the Files tree for every decoded chunk.
  const currentBusyReason = useAtomValue(
    environmentId === null ? noFileTransferOperation : fileTransfers.operation(environmentId),
    busyReason,
  );
  const prepare = useAtomCommand(fileTransfers.prepareDownload, { reportFailure: false });
  const mintHttp = useAtomCommand(fileTransfers.prepareHttpDownload, { reportFailure: false });
  const download = useAtomCommand(fileTransfers.download, { reportFailure: false });
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const unavailableReason = !availability.connected
    ? DISCONNECTED
    : availability.route === "unavailable"
      ? transferUnavailableCopy(availability.serverName)
      : availability.route === "in-channel" &&
          bridge !== undefined &&
          streamingDownloadBridge(bridge) === null
        ? UPDATE_DOWNLOAD_APP
        : null;
  const downloadDisabledReason = unavailableReason ?? currentBusyReason;
  const uploadDisabledReason =
    availability.route === "http"
      ? null
      : !availability.connected
        ? DISCONNECTED
        : transferUnavailableCopy(availability.serverName);
  const downloadEntry = useCallback(
    (relativePath: string) => {
      const name = entryName(relativePath);
      if (environmentId === null || downloadDisabledReason !== null) {
        showMutationError(
          new Error(downloadDisabledReason ?? DISCONNECTED),
          `Can’t download "${name}"`,
        );
        return;
      }
      void (async () => {
        const prepared = await prepare({ environmentId, cwd, relativePath });
        if (prepared._tag === "Failure") {
          if (!isAtomCommandInterrupted(prepared))
            showMutationError(
              squashAtomCommandFailure(prepared),
              `Failed to prepare a download for "${name}"`,
            );
          return;
        }
        const admission = prepared.value;
        try {
          if (admission.route === "http") {
            const outcome = await downloadWithBridge({
              bridge,
              prepare: async () => {
                const minted = await mintHttp({ environmentId, admission });
                if (minted._tag === "Failure") {
                  if (!isAtomCommandInterrupted(minted))
                    showMutationError(
                      squashAtomCommandFailure(minted),
                      `Failed to prepare a download for "${name}"`,
                    );
                  // HTTP errors use the existing Files error presenter, not a duplicate root toast.
                  fileTransfers.dismiss(registry, environmentId, admission.operationId);
                  return null;
                }
                return { url: minted.value.url, fileName: minted.value.fileName };
              },
            });
            if (outcome._tag === "BrowserDownload")
              triggerBrowserDownload(outcome.url, outcome.fileName);
            else if (outcome._tag === "Saved")
              toasts.add(
                stackedThreadToast({
                  type: "success",
                  title: "Download saved",
                  description: outcome.path,
                }),
              );
          } else {
            if (bridge === undefined) {
              await download({ environmentId, admission, sink: browserDownloadSink() });
            } else {
              const native = streamingDownloadBridge(bridge);
              if (native === null) {
                showMutationError(new Error(UPDATE_DOWNLOAD_APP), `Can’t download "${name}"`);
                return;
              }
              const directory = await bridge.pickFolder({ initialPath: null });
              if (directory !== null)
                await download({
                  environmentId,
                  admission,
                  sink: desktopDownloadSink(native, directory),
                });
            }
          }
        } catch (error) {
          showMutationError(error, `Failed to download "${name}"`);
        } finally {
          // Native HTTP has no Cancel API. Only the actual bridge promise completion releases it.
          // Consumed in-channel tokens cannot release active/ready or another invocation.
          fileTransfers.releaseAdmission(registry, environmentId, admission);
        }
      })();
    },
    [
      bridge,
      cwd,
      download,
      downloadDisabledReason,
      environmentId,
      mintHttp,
      prepare,
      registry,
      showMutationError,
      toasts,
    ],
  );
  const getUploadDisabledReason = useCallback(() => {
    if (environmentId === null) return DISCONNECTED;
    const current = registry.get(fileTransfers.availability(environmentId));
    return current.route === "http"
      ? null
      : !current.connected
        ? DISCONNECTED
        : transferUnavailableCopy(current.serverName);
  }, [environmentId, registry]);
  return { downloadEntry, downloadDisabledReason, uploadDisabledReason, getUploadDisabledReason };
}
