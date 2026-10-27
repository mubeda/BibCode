import { useCallback, useState } from "react";

import { toastManager } from "../components/ui/toast";
import { downloadDiagnosticLogs, type DiagnosticLogsOptions } from "./downloadDiagnosticLogs";
import { readFrontendLogSnapshot } from "./frontendLogCapture";

/**
 * Prepares an environment's diagnostic ZIP and reports the outcome in a toast: the primary
 * environment's unless `options.environment` names another one. One download runs at a time
 * per caller.
 */
export function useDiagnosticLogsDownload() {
  const [status, setStatus] = useState<"idle" | "downloading">("idle");

  const download = useCallback(
    (options?: DiagnosticLogsOptions) => {
      if (status === "downloading") return;
      setStatus("downloading");
      const label = options?.environment?.label;
      void (async () => {
        try {
          const result = await downloadDiagnosticLogs(readFrontendLogSnapshot(), options);
          if (result.status === "saved") {
            toastManager.add({
              type: "success",
              title:
                label === undefined
                  ? "Diagnostic logs saved"
                  : `Diagnostic logs from ${label} saved`,
              description: result.path,
            });
          } else if (result.status === "downloaded") {
            toastManager.add({
              type: "success",
              title:
                label === undefined
                  ? "Diagnostic logs download started"
                  : `Diagnostic logs from ${label} downloading`,
              description: result.filename,
            });
          }
        } catch (error) {
          toastManager.add({
            type: "error",
            title:
              label === undefined
                ? "Could not download diagnostic logs"
                : `Could not download ${label}'s logs`,
            description:
              error instanceof Error ? error.message : "Unable to prepare the diagnostic archive.",
          });
        } finally {
          setStatus("idle");
        }
      })();
    },
    [status],
  );

  return { isDownloading: status === "downloading", download };
}
