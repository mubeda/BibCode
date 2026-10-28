import { diagnosticLogsFailureMessage } from "@bibcode/client-runtime/diagnostics";
import type { EnvironmentId } from "@bibcode/contracts";
import { DownloadIcon, InfoIcon } from "lucide-react";
import { useId } from "react";

import { serverHasDiagnosticLogs } from "../../diagnostics/diagnosticLogsSupport";
import { useDiagnosticLogsDownload } from "../../diagnostics/useDiagnosticLogsDownload";
import type { EnvironmentPresentation } from "../../state/environments";
import { Button } from "../ui/button";
import { useDiagnosticsEnvironment } from "./diagnosticsEnvironment";
import { SettingsRow, SettingsSection } from "./settingsLayout";

// Phases in which an environment is on its way to connected.
const CONNECTING_PHASES: ReadonlySet<string> = new Set(["connecting", "reconnecting", "available"]);

/** Why the download cannot run for `target` now; `null` when it can. */
function disabledReasonFor(
  target: EnvironmentPresentation,
  label: string,
  isPrimary: boolean,
): string | null {
  const phase = target.connection.phase;
  if (phase !== "connected") {
    return CONNECTING_PHASES.has(phase)
      ? `${label} is still connecting. Download its logs once it is connected.`
      : diagnosticLogsFailureMessage("not-connected", label);
  }
  if (isPrimary || serverHasDiagnosticLogs(target.serverConfig)) return null;
  return diagnosticLogsFailureMessage("unsupported", label);
}

/**
 * Downloads the redacted diagnostic ZIP of exactly the environment the page has selected:
 * the primary when the route names none (over its HTTP route as before), any other over its
 * own connection (#194). The environment is picked in the Profiler section, whose selection
 * this row shares. A download never goes to an environment this row does not name.
 */
export function DiagnosticLogsSection({
  selectedEnvironmentId,
  onSelectEnvironment,
}: {
  /** The page's environment, kept by the route; the same one the Profiler section shows. */
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly onSelectEnvironment: (environmentId: EnvironmentId | null) => void;
}) {
  const { environments, primaryEnvironment } = useDiagnosticsEnvironment(
    selectedEnvironmentId,
    onSelectEnvironment,
  );
  const { isDownloading, download } = useDiagnosticLogsDownload();
  const reasonId = useId();
  // The environment the route names, or the primary; never a stand-in for either.
  const target =
    selectedEnvironmentId === null
      ? primaryEnvironment
      : (environments.find((candidate) => candidate.environmentId === selectedEnvironmentId) ??
        null);
  const isPrimary =
    target === null
      ? selectedEnvironmentId === null
      : target.environmentId === primaryEnvironment?.environmentId;
  const label = target?.label.trim() || "the server";
  const disabledReason =
    target !== null
      ? disabledReasonFor(target, label, isPrimary)
      : selectedEnvironmentId !== null
        ? // Chosen, but not in the catalog (yet, or any more).
          diagnosticLogsFailureMessage("not-connected", "The chosen environment")
        : // The catalog is still loading: the primary's HTTP route needs nothing from it.
          null;

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
          <Button
            aria-label="Download diagnostic logs"
            aria-describedby={disabledReason === null ? undefined : reasonId}
            disabled={isDownloading || disabledReason !== null}
            onClick={() =>
              download(
                isPrimary || target === null
                  ? undefined
                  : { environment: { environmentId: target.environmentId, label } },
              )
            }
          >
            <DownloadIcon className="size-3.5" />
            {isDownloading ? "Preparing logs..." : "Download logs"}
          </Button>
        }
      />
    </SettingsSection>
  );
}
