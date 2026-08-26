import { RouterProvider } from "@tanstack/react-router";
import { EnvironmentId } from "@bibcode/contracts";
import { useEffect, useRef, useState } from "react";

import { ProjectDataRecoveryDialog } from "./components/desktop/ProjectDataRecoveryDialog";
import { PreviewAutomationHosts } from "./components/preview/PreviewAutomationHosts";
import { previewBridge } from "./components/preview/previewBridge";
import { supportsPreviewRuntimeCapability } from "./previewRuntimeCapabilities";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";
import { ThreadLifecycleReconciler } from "./ThreadLifecycleReconciler";
import { projectDataSafetyStore, useProjectDataSafetySnapshot } from "./state/projectDataSafety";
import { environmentAvailabilityCommands, useEnvironmentShellSummary } from "./state/shell";
import { useAtomCommand } from "./state/use-atom-command";
import { useEnvironments } from "./state/environments";
import { isDesktopLocalConnectionTarget } from "./connection/desktopLocal";
import { ForgottenEnvironmentClientCleanupCoordinator } from "./ForgottenEnvironmentClientCleanupCoordinator";

export function ProjectDataRecoveryCoordinator() {
  const summary = useEnvironmentShellSummary();
  const snapshot = useProjectDataSafetySnapshot();
  const retryEnvironment = useAtomCommand(environmentAvailabilityCommands.retry, {
    reportFailure: false,
  });
  const adoptStorage = useAtomCommand(environmentAvailabilityCommands.adoptStorage, {
    reportFailure: false,
  });
  const { environments } = useEnvironments();
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const hasDesktopRecovery = bridge?.getProjectDataStatuses !== undefined;
  const [bridgeRecoveryEnvironmentId, setBridgeRecoveryEnvironmentId] = useState<string | null>(
    null,
  );
  const localEnvironmentIds = new Set(
    environments
      .filter(
        (environment) =>
          hasDesktopRecovery &&
          (environment.entry.target._tag === "PrimaryConnectionTarget" ||
            isDesktopLocalConnectionTarget(environment.entry.target)),
      )
      .map((environment) => environment.environmentId),
  );
  const shellRecoveryEnvironmentId =
    summary.statuses.find(
      (status) =>
        status.status === "recovery-required" && localEnvironmentIds.has(status.environmentId),
    )?.environmentId ?? null;
  const automaticEnvironmentId = shellRecoveryEnvironmentId ?? bridgeRecoveryEnvironmentId;
  const lastAutomaticEnvironmentId = useRef<string | null>(null);

  useEffect(() => {
    if (bridge?.getProjectDataStatuses === undefined) {
      setBridgeRecoveryEnvironmentId(null);
      return;
    }

    let active = true;
    const inspect = async () => {
      const statuses = await bridge.getProjectDataStatuses?.();
      if (!active || statuses === undefined) {
        return;
      }
      setBridgeRecoveryEnvironmentId(
        statuses.find((status) => status.status === "recovery-required")?.environmentId ?? null,
      );
    };

    void inspect().catch(() => undefined);
    const dispose = bridge.onProjectDataStatusChanged?.(() => {
      void inspect().catch(() => undefined);
    });
    return () => {
      active = false;
      dispose?.();
    };
  }, [bridge]);

  useEffect(() => {
    if (automaticEnvironmentId === null) {
      lastAutomaticEnvironmentId.current = null;
      return;
    }
    if (!hasDesktopRecovery || lastAutomaticEnvironmentId.current === automaticEnvironmentId) {
      return;
    }
    lastAutomaticEnvironmentId.current = automaticEnvironmentId;
    void projectDataSafetyStore.open(automaticEnvironmentId, "automatic").catch(() => undefined);
  }, [automaticEnvironmentId, hasDesktopRecovery]);

  const environmentId = snapshot.environmentId;
  return (
    <ProjectDataRecoveryDialog
      open={snapshot.open}
      status={snapshot.selected}
      busy={snapshot.busy}
      error={snapshot.error}
      restartError={snapshot.lastResult?.restartError ?? null}
      requiresStorageAdoption={snapshot.requiresStorageAdoption}
      onOpenChange={(open) => {
        if (!open) projectDataSafetyStore.close();
      }}
      onRetry={() => {
        const recoveryResult = snapshot.lastResult;
        void projectDataSafetyStore
          .retry()
          .then(async () => {
            if (
              recoveryResult?.committed === true &&
              recoveryResult.action === "restore" &&
              environmentId !== null
            ) {
              await retryEnvironment(EnvironmentId.make(environmentId));
              projectDataSafetyStore.close();
            }
          })
          .catch(() => undefined);
      }}
      onRestore={async (backupId) => {
        const result = await projectDataSafetyStore.restore(backupId);
        if (result.restartError === null && environmentId !== null) {
          await retryEnvironment(EnvironmentId.make(environmentId));
          projectDataSafetyStore.close();
        }
      }}
      onStartEmpty={() => projectDataSafetyStore.startEmpty().then(() => undefined)}
      onAdoptStorage={async () => {
        if (environmentId !== null) {
          await adoptStorage(EnvironmentId.make(environmentId));
          projectDataSafetyStore.close();
        }
      }}
      onOpenPath={() => {
        void projectDataSafetyStore.openPath().catch(() => undefined);
      }}
      onExportDiagnostics={() => {
        void projectDataSafetyStore.exportDiagnostics().catch(() => undefined);
      }}
    />
  );
}

/** Owns renderer-wide providers shared by routed UI and automation hosts. */
export function AppRoot({ router }: { readonly router: AppRouter }) {
  return (
    <AppAtomRegistryProvider>
      <ForgottenEnvironmentClientCleanupCoordinator />
      <ThreadLifecycleReconciler />
      <ProjectDataRecoveryCoordinator />
      <RouterProvider router={router} />
      {supportsPreviewRuntimeCapability(previewBridge, "automation") ? (
        <PreviewAutomationHosts />
      ) : null}
    </AppAtomRegistryProvider>
  );
}
