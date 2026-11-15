import { useEffect, useState, type RefObject } from "react";
import {
  acquireBrowserSurfaceOcclusion,
  type BrowserSurfaceRect,
} from "~/browser/browserSurfaceStore";
import { isDesktopHost } from "~/env";
import { isMacPlatform } from "~/lib/utils";

function measure(element: HTMLElement): BrowserSurfaceRect {
  const rect = element.getBoundingClientRect();
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  };
}

/**
 * A macOS native preview is a view above the webview, so a popup drawn over it would sit under
 * it. While `open`, lease the positioner's rectangle, which hides the preview only where the
 * popup overlaps it. A frame loop keeps the rectangle current: it also catches movement without
 * resizing (anchor scroll, repositioning, the positioner's own transition) that no observer
 * reports, and it runs only while open.
 */
export function usePopupOcclusion(
  open: boolean,
  positionerRef: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    const element = positionerRef.current;
    if (!open || !element || !isDesktopHost || !isMacPlatform(navigator.platform)) return;
    let current = measure(element);
    const lease = acquireBrowserSurfaceOcclusion(current);
    let frame = requestAnimationFrame(function track() {
      const next = measure(element);
      if (
        next.x !== current.x ||
        next.y !== current.y ||
        next.width !== current.width ||
        next.height !== current.height
      ) {
        current = next;
        lease.update(next);
      }
      frame = requestAnimationFrame(track);
    });
    return () => {
      cancelAnimationFrame(frame);
      lease.release();
    };
  }, [open, positionerRef]);
}

/**
 * Render inside a popup's Positioner. Base UI 1.9 marks the Positioner with `data-open` while
 * the popup is open, also when its portal stays mounted while closed.
 */
export function PopupOcclusion({
  positionerRef,
}: {
  positionerRef: RefObject<HTMLElement | null>;
}): null {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const element = positionerRef.current;
    if (!element) return;
    const read = () => setOpen(element.hasAttribute("data-open"));
    read();
    const observer = new MutationObserver(read);
    observer.observe(element, { attributeFilter: ["data-open"] });
    return () => observer.disconnect();
  }, [positionerRef]);
  usePopupOcclusion(open, positionerRef);
  return null;
}
