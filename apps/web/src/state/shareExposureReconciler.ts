import { useAtomValue } from "@effect/atom-react";
import type {
  AuthShareStateResult,
  DesktopBridge,
  DesktopServerExposureMode,
  DesktopServerExposureState,
  EnvironmentId,
} from "@bibcode/contracts";
import { useCallback, useEffect, useRef } from "react";

import { toastManager } from "../components/ui/toast";
import { getServerShareState } from "../environments/primary";
import { authEnvironment } from "./auth";
import { refreshDesktopNetworkAccessState } from "./desktopNetworkAccess";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { useEnvironmentQuery } from "./query";

export function shouldRevertExposure(input: {
  readonly shareState: AuthShareStateResult;
  readonly exposureMode: DesktopServerExposureMode;
}): boolean {
  return (
    input.exposureMode === "network-accessible" &&
    input.shareState.desiredExposure === "loopback" &&
    input.shareState.legacyGrantCount === 0
  );
}

export interface ShareExposureOperations {
  readonly getShareState: () => Promise<AuthShareStateResult>;
  readonly getExposureState: () => Promise<DesktopServerExposureState>;
  readonly applyExposure: (
    desired: DesktopServerExposureMode,
  ) => Promise<DesktopServerExposureState>;
}

export type ShareExposureReconciliationOutcome = "unchanged" | "narrowed" | "widened" | "rewidened";

export async function reconcileShareExposureOnce(
  operations: ShareExposureOperations,
): Promise<ShareExposureReconciliationOutcome> {
  const [shareState, exposureState] = await Promise.all([
    operations.getShareState(),
    operations.getExposureState(),
  ]);
  if (
    shareState.desiredExposure === "wide" &&
    exposureState.mode === "local-only"
  ) {
    await operations.applyExposure("network-accessible");
    refreshDesktopNetworkAccessState();
    return "widened";
  }
  if (!shouldRevertExposure({ shareState, exposureMode: exposureState.mode })) {
    return "unchanged";
  }

  await operations.applyExposure("local-only");
  refreshDesktopNetworkAccessState();
  const confirmedShareState = await operations.getShareState();
  if (confirmedShareState.desiredExposure !== "wide") return "narrowed";

  await operations.applyExposure("network-accessible");
  refreshDesktopNetworkAccessState();
  return "rewidened";
}

interface ReconcileTarget {
  readonly bridge: DesktopBridge | undefined;
  readonly primaryEnvironmentId: EnvironmentId | null;
}

export function useShareExposureReconciler(): void {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  const canReconcile = bridge?.applyServerExposure !== undefined && primaryEnvironmentId !== null;
  const accessChanges = useEnvironmentQuery(
    canReconcile
      ? authEnvironment.accessChanges({ environmentId: primaryEnvironmentId, input: null })
      : null,
  );
  const revision = accessChanges.data?.revision ?? null;
  const targetRef = useRef<ReconcileTarget>({ bridge, primaryEnvironmentId });
  targetRef.current = { bridge, primaryEnvironmentId };
  const requestedRef = useRef(false);
  const inFlightRef = useRef<Promise<void> | null>(null);

  const requestReconcile = useCallback(() => {
    requestedRef.current = true;
    if (inFlightRef.current !== null) return;

    const run = async () => {
      while (requestedRef.current) {
        requestedRef.current = false;
        const target = targetRef.current;
        const targetBridge = target.bridge;
        if (
          targetBridge?.applyServerExposure === undefined ||
          targetBridge.getServerExposureState === undefined ||
          target.primaryEnvironmentId === null
        ) {
          continue;
        }
        try {
          const outcome = await reconcileShareExposureOnce({
            getShareState: getServerShareState,
            getExposureState: () => targetBridge.getServerExposureState(),
            applyExposure: (desired) => targetBridge.applyServerExposure(desired),
          });
          if (outcome === "narrowed") {
            toastManager.add({
              type: "info",
              title: "Remote access switched off",
              description:
                "No active off-host pairings remain, so the local server is loopback-only again.",
            });
          }
        } catch (error) {
          console.warn("[remote-sharing] Could not reconcile server exposure.", error);
        }
      }
    };

    const inFlight = run().finally(() => {
      if (inFlightRef.current === inFlight) inFlightRef.current = null;
    });
    inFlightRef.current = inFlight;
  }, []);

  useEffect(() => {
    if (!canReconcile) return;
    requestReconcile();
  }, [canReconcile, requestReconcile, revision]);
}
