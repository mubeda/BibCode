import { useEffect } from "react";
import { acquireBrowserSurfaceOcclusion } from "~/browser/browserSurfaceStore";
import { isDesktopHost } from "~/env";
import { isMacPlatform } from "~/lib/utils";

/**
 * A macOS native preview is a view above the webview, so a modal surface drawn over it would sit
 * under it. While `active`, hold an occlusion lease, which hides the whole preview. Menus and
 * popovers use `usePopupOcclusion` instead, which hides it only where the popup overlaps it.
 */
export function useNativePreviewOcclusion(active: boolean): void {
  useEffect(() => {
    if (!active || !isDesktopHost || !isMacPlatform(navigator.platform)) return;
    return acquireBrowserSurfaceOcclusion().release;
  }, [active]);
}

/** Render inside a portal that mounts only while the surface is open. */
export function NativePreviewOcclusion(): null {
  useNativePreviewOcclusion(true);
  return null;
}
