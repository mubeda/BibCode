import type { NativeSharingRouteScope } from "./release-visual-native-sharing-route.ts";
export type NativeSharingScene = "native-share-no-route" | "native-share-refresh";
export interface NativeSharingVisualPorts {
  readonly theme: (theme: "light" | "dark") => Promise<void>;
  readonly openShare: () => Promise<void>;
  readonly refresh: () => Promise<void>;
  readonly verifyIdentity: () => Promise<void>;
  readonly withMissingRoute: (
    run: (scope: NativeSharingRouteScope) => Promise<void>,
  ) => Promise<void>;
  readonly verifyRoute: (
    scope: NativeSharingRouteScope,
    expected: "absent" | "owned",
  ) => Promise<void>;
  readonly capture: (scene: NativeSharingScene, theme: "light" | "dark") => Promise<void>;
  readonly restoreOriginal: () => Promise<void>;
  readonly unsafeCleanup: () => void;
}
export async function runNativeSharingVisual(ports: NativeSharingVisualPorts): Promise<object> {
  let failed = false,
    failure: unknown;
  try {
    await ports.verifyIdentity();
    for (const theme of ["light", "dark"] as const) {
      await ports.theme(theme);
      await ports.verifyIdentity();
      await ports.withMissingRoute(async (scope) => {
        await ports.verifyRoute(scope, "absent");
        await ports.openShare();
        await ports.refresh();
        await ports.verifyRoute(scope, "absent");
        await ports.verifyIdentity();
        await ports.capture("native-share-no-route", theme);
        await ports.verifyRoute(scope, "absent");
        await ports.verifyIdentity();
        await scope.restore();
        await ports.verifyRoute(scope, "owned");
        await ports.refresh();
        await ports.verifyIdentity();
        await ports.capture("native-share-refresh", theme);
        await ports.verifyRoute(scope, "owned");
        await ports.verifyIdentity();
      });
    }
  } catch (error) {
    failed = true;
    failure = error;
  }
  let cleanupFailed = false;
  try {
    await ports.restoreOriginal();
    await ports.verifyIdentity();
  } catch {
    cleanupFailed = true;
    try {
      ports.unsafeCleanup();
    } catch {
      /* Preserve the original operation. */
    }
  }
  if (failed) throw failure;
  if (cleanupFailed) throw new Error("Owned native sharing visual cleanup refused.");
  return Object.freeze({
    nativeSharingOnly: true,
    completeGroup: false,
    twoExistingRows: true,
    bothThemes: true,
    noOfferMinted: true,
    originalRestored: true,
  });
}
