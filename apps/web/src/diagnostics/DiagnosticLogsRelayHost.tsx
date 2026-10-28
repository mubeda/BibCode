import {
  claimDiagnosticLogsRelay,
  sendDiagnosticLogsRelayItem,
  watchDiagnosticLogsRelay,
} from "@bibcode/client-runtime/diagnostics";
import { useEffect, useRef } from "react";

import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Button } from "../components/ui/button";
import {
  type EnvironmentPresentation,
  useEnvironments,
  usePrimaryEnvironment,
} from "../state/environments";
import {
  DiagnosticLogsRelayController,
  type DiagnosticLogsRelayPrompt,
  useDiagnosticLogsRelayPrompts,
} from "./diagnosticLogsRelay";
import { diagnosticLogsDownloadInput } from "./downloadDiagnosticLogs";
import {
  downloadEnvironmentDiagnosticLogs,
  runInEnvironmentAsPromise,
} from "./environmentDiagnosticLogs";
import { readFrontendLogSnapshot } from "./frontendLogCapture";

const asIs = (failure: unknown) => failure;

/**
 * The desktop app's answer to `bibcode diagnostics download` on this computer (#201): while
 * its own server is connected, it listens for requests, asks before sharing anything, and
 * relays the named environment's logs. Mounted once, on desktop hosts only.
 */
export function DiagnosticLogsRelayHost() {
  const primary = usePrimaryEnvironment();
  const { environments } = useEnvironments();
  const environmentsRef = useRef<ReadonlyArray<EnvironmentPresentation>>(environments);
  const controllerRef = useRef<DiagnosticLogsRelayController | null>(null);
  const prompt = useDiagnosticLogsRelayPrompts((state) => state.prompts[0] ?? null);
  const primaryId = primary?.environmentId ?? null;
  const connected = primary?.connection.phase === "connected";

  useEffect(() => {
    environmentsRef.current = environments;
  }, [environments]);

  useEffect(() => {
    if (primaryId === null || !connected) return;
    const controller = new DiagnosticLogsRelayController({
      candidates: () =>
        environmentsRef.current.map((environment) => ({
          environmentId: environment.environmentId,
          label: environment.label,
          connected: environment.connection.phase === "connected",
        })),
      claim: (requestId) =>
        runInEnvironmentAsPromise(primaryId, claimDiagnosticLogsRelay(requestId), asIs),
      send: (requestId, item) =>
        runInEnvironmentAsPromise(primaryId, sendDiagnosticLogsRelayItem(requestId, item), asIs),
      download: downloadEnvironmentDiagnosticLogs,
      downloadInput: (includeCrashDumps) =>
        diagnosticLogsDownloadInput(readFrontendLogSnapshot(), { includeCrashDumps }),
    });
    controllerRef.current = controller;
    const subscription = new AbortController();
    void runInEnvironmentAsPromise(
      primaryId,
      watchDiagnosticLogsRelay((event) => controller.handle(event)),
      asIs,
      subscription.signal,
    ).catch(() => undefined);
    return () => {
      subscription.abort();
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [primaryId, connected]);

  if (prompt === null) return null;
  return (
    <DiagnosticLogsRelayDialog
      prompt={prompt}
      onAllow={() => void controllerRef.current?.approve(prompt)}
      onDeny={() => void controllerRef.current?.deny(prompt)}
    />
  );
}

/** Asks before any logs leave: who asked, whose logs, what they hold. Dismissing denies. */
export function DiagnosticLogsRelayDialog({
  prompt,
  onAllow,
  onDeny,
}: {
  readonly prompt: DiagnosticLogsRelayPrompt;
  readonly onAllow: () => void;
  readonly onDeny: () => void;
}) {
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) onDeny();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Share {prompt.label}'s diagnostic logs?</AlertDialogTitle>
          <AlertDialogDescription>
            A command on this computer (<span className="font-mono">bibcode diagnostics</span>) asks
            for {prompt.label}'s redacted logs. They are saved where that command runs.
            {prompt.includeCrashDumps
              ? " It also asks for crash dumps, which can hold fragments of memory."
              : ""}{" "}
            The request ends in 2 minutes if you do not answer.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" onClick={onDeny}>
            Deny
          </Button>
          <Button onClick={onAllow}>
            {prompt.includeCrashDumps ? "Share logs and crash dumps" : "Share logs"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
