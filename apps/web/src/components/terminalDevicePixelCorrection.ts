export interface DevicePixelCorrectionDisposable {
  dispose(): void;
}

const NO_CORRECTION: DevicePixelCorrectionDisposable = { dispose() {} };

/**
 * Whether the browser reports a canvas's exact device-pixel box itself.
 *
 * Chromium does; WebKit does not (https://bugs.webkit.org/show_bug.cgi?id=219005).
 * xterm's WebGL renderer observes `device-pixel-content-box` to snap its backing
 * store to that exact box, and silently disconnects its observer for good when
 * the property is missing — so on WebKit the correction never runs.
 */
function supportsDevicePixelContentBox(): boolean {
  return (
    typeof ResizeObserverEntry !== "undefined" &&
    "devicePixelContentBoxSize" in ResizeObserverEntry.prototype
  );
}

/**
 * Restores xterm's device-pixel canvas correction on engines that lack the
 * native path.
 *
 * xterm sizes the WebGL canvas backing store from its own cell math and the CSS
 * box from `Math.round(deviceSize / devicePixelRatio)`. That rounding can leave
 * the two disagreeing by a fraction of a device pixel, and the compositor then
 * rescales the whole canvas — every glyph is resampled, which reads as blurred
 * or smeared text. It only bites when `devicePixelRatio !== 1`, which is why
 * macOS (Retina and scaled display modes) shows it and a Chromium host does not.
 *
 * `getBoundingClientRect()` returns fractional CSS pixels, so multiplying by the
 * ratio recovers the same exact device-pixel box `device-pixel-content-box`
 * would have reported.
 *
 * Returns a no-op disposable where the native path already applies, so this
 * never double-corrects against xterm's own observer.
 */
export function observeCanvasDevicePixelSize(
  canvas: HTMLCanvasElement,
  requestRedraw: () => void,
): DevicePixelCorrectionDisposable {
  if (supportsDevicePixelContentBox()) return NO_CORRECTION;
  if (typeof ResizeObserver === "undefined") return NO_CORRECTION;

  const applyExactSize = (): void => {
    const rect = canvas.getBoundingClientRect();
    const ratio = globalThis.devicePixelRatio || 1;
    const width = Math.round(rect.width * ratio);
    const height = Math.round(rect.height * ratio);
    // A zero box means the canvas is hidden; resizing it away would discard the
    // drawing buffer and force a redraw of nothing.
    if (width <= 0 || height <= 0) return;
    if (canvas.width === width && canvas.height === height) return;
    canvas.width = width;
    canvas.height = height;
    requestRedraw();
  };

  const observer = new ResizeObserver(applyExactSize);
  observer.observe(canvas);
  return {
    dispose() {
      observer.disconnect();
    },
  };
}
