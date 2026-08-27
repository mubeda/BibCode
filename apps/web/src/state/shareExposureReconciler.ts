import { useAtomValue } from "@effect/atom-react";
import type {
  AuthShareStateResult,
  DesktopBridge,
  DesktopServerExposureMode,
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
        if (
          target.bridge?.applyServerExposure === undefined ||
          target.bridge.getServerExposureState === undefined ||
          target.primaryEnvironmentId === null
        ) {
          continue;
        }
        try {
          const [shareState, exposureState] = await Promise.all([
            getServerShareState(),
            target.bridge.getServerExposureState(),
          ]);
          if (
            shouldRevertExposure({
              shareState,
              exposureMode: exposureState.mode,
            })
          ) {
            await target.bridge.applyServerExposure("local-only");
            refreshDesktopNetworkAccessState();
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
