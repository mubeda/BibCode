import { useEffect, useMemo, useRef } from "react";

import { reconcileForgottenEnvironmentClientCleanup } from "./connection/catalog";
import { stackedThreadToast, toastManager } from "./components/ui/toast";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { useEnvironments } from "./state/environments";

/** Reconciles browser-local privacy cleanup after an interrupted successful Forget. */
export function ForgottenEnvironmentClientCleanupCoordinator() {
  const { catalogEnvironmentIds, isReady } = useEnvironments();
  const activeEnvironmentIds = useMemo(
    () => new Set(catalogEnvironmentIds),
    [catalogEnvironmentIds],
  );
  const catalogSignature = [...activeEnvironmentIds].sort().join("\u0000");
  const lastReconciledCatalogSignature = useRef<string | null>(null);

  useEffect(() => {
    if (!isReady || lastReconciledCatalogSignature.current === catalogSignature) return;
    lastReconciledCatalogSignature.current = catalogSignature;
    let active = true;
    void reconcileForgottenEnvironmentClientCleanup(appAtomRegistry, activeEnvironmentIds).then(
      (result) => {
        if (!active || (result.incompleteEnvironmentIds.length === 0 && !result.storageError)) {
          return;
        }
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Private metadata cleanup needs attention",
            description:
              "BiBCode could not verify removal of local navigation metadata. It will retry after restart; browser storage may need to be made available.",
          }),
        );
      },
    );
    return () => {
      active = false;
    };
  }, [activeEnvironmentIds, catalogSignature, isReady]);

  return null;
}
