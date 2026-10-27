import { diagnosticLogsFailureMessage } from "@bibcode/client-runtime/diagnostics";
import type { EnvironmentId } from "@bibcode/contracts";
import { DownloadIcon, InfoIcon } from "lucide-react";
import { useId } from "react";

import { serverHasDiagnosticLogs } from "../../diagnostics/diagnosticLogsSupport";
import { useDiagnosticLogsDownload } from "../../diagnostics/useDiagnosticLogsDownload";
import { Button } from "../ui/button";
import { DiagnosticsEnvironmentSelect, useDiagnosticsEnvironment } from "./diagnosticsEnvironment";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/**
 * Downloads the redacted diagnostic ZIP of the environment the page has selected: the primary
 * over its HTTP route as before, any other over its own connection (#194). A download never
 * goes to another environment than the one this row names.
 */
export function DiagnosticLogsSection({
  selectedEnvironmentId,
  onSelectEnvironment,
}: {
  /** The page's environment, kept by the route; the same one the Profiler section shows. */
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly onSelectEnvironment: (environmentId: EnvironmentId | null) => void;
}) {
  const { environments, connected, primaryEnvironment, environment, waitingFor } =
    useDiagnosticsEnvironment(selectedEnvironmentId, onSelectEnvironment);
  const { isDownloading, download } = useDiagnosticLogsDownload();
  const reasonId = useId();
  // The chosen environment, not the stand-in the page shows while the chosen one connects.
  const target = waitingFor ?? environment;
  const remote =
    target !== null && target.environmentId !== primaryEnvironment?.environmentId ? target : null;
  const label = target?.label.trim() || "the server";
  const disabledReason =
    remote === null
      ? null
      : waitingFor !== undefined || remote.connection.phase !== "connected"
        ? diagnosticLogsFailureMessage("not-connected", label)
        : serverHasDiagnosticLogs(remote.serverConfig)
          ? null
          : diagnosticLogsFailureMessage("unsupported", label);

  return (
    <SettingsSection title="Diagnostic logs">
      <SettingsRow
        title="Download diagnostic logs"
        description={
          <>
            Download a redacted ZIP containing <span className="font-mono">server.log</span>,{" "}
            <span className="font-mono">server.trace.ndjson</span>,{" "}
            <span className="font-mono">frontend.log</span>, and any recorded{" "}
            <span className="font-mono">profiler</span> data (without crash dumps)
            {target === null ? "" : ` from ${label}`}.
          </>
        }
        status={
          disabledReason === null ? null : (
            <div id={reasonId} className="flex items-start gap-1.5">
              <InfoIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <span>{disabledReason}</span>
            </div>
          )
        }
        control={
          <div className="flex flex-wrap items-center gap-2">
            {connected.length > 1 && environment !== null ? (
              <DiagnosticsEnvironmentSelect
                environments={environments}
                value={target ?? environment}
                onSelectEnvironment={onSelectEnvironment}
              />
            ) : null}
            <Button
              aria-label="Download diagnostic logs"
              aria-describedby={disabledReason === null ? undefined : reasonId}
              disabled={isDownloading || disabledReason !== null}
              onClick={() =>
                download(
                  remote === null
                    ? undefined
                    : { environment: { environmentId: remote.environmentId, label } },
                )
              }
            >
              <DownloadIcon className="size-3.5" />
              {isDownloading ? "Preparing logs..." : "Download logs"}
            </Button>
          </div>
        }
      />
    </SettingsSection>
  );
}
