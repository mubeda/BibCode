export type WebglAddonInstance = import("@xterm/addon-webgl").WebglAddon;

export async function loadTerminalWebglAddon(): Promise<typeof import("@xterm/addon-webgl")> {
  return import("@xterm/addon-webgl");
}

/**
 * The addon exposes neither its renderer nor its rendering context, so the
 * callers that need to release the context or measure the canvas both read the
 * same private handle through here.
 */
export function webglContextFrom(addon: WebglAddonInstance): WebGL2RenderingContext | undefined {
  try {
    return (
      addon as unknown as {
        readonly _renderer?: { readonly _gl?: WebGL2RenderingContext };
      }
    )._renderer?._gl;
  } catch {
    // Private renderer details can change between compatible addon releases.
    return undefined;
  }
}

/**
 * The canvas xterm paints the terminal into, when it can be reached. Only
 * getting at the context is version-sensitive — `gl.canvas` itself is standard.
 *
 * Duck-typed rather than an `instanceof` check so this keeps working across
 * realms, and so an `OffscreenCanvas` (which cannot be measured against the
 * layout) is correctly rejected.
 */
export function webglCanvasFrom(addon: WebglAddonInstance): HTMLCanvasElement | null {
  const canvas = webglContextFrom(addon)?.canvas;
  if (!canvas) return null;
  const measurable = canvas as HTMLCanvasElement;
  return typeof measurable.getBoundingClientRect === "function" ? measurable : null;
}

interface WebglResizeLayer {
  handleResize(): void;
}

/**
 * Resize xterm's WebGL backing store without leaving its viewport or shader
 * resolution on the previous pane dimensions.
 *
 * xterm's renderer layers are private, so validate the complete pinned-addon
 * shape before mutating the canvas. If that shape changes, keeping the previous
 * exact cell-sized backing store is safer than resizing only the drawing buffer.
 */
export function resizeWebglCanvasBackingStore(
  addon: WebglAddonInstance,
  width: number,
  height: number,
): boolean {
  try {
    const renderer = (
      addon as unknown as {
        readonly _renderer?: {
          readonly _gl?: WebGL2RenderingContext;
          readonly _rectangleRenderer?: { readonly value?: WebglResizeLayer };
          readonly _glyphRenderer?: { readonly value?: WebglResizeLayer };
        };
      }
    )._renderer;
    const canvas = renderer?._gl?.canvas as HTMLCanvasElement | undefined;
    const rectangleRenderer = renderer?._rectangleRenderer?.value;
    const glyphRenderer = renderer?._glyphRenderer?.value;
    if (
      !canvas ||
      typeof rectangleRenderer?.handleResize !== "function" ||
      typeof glyphRenderer?.handleResize !== "function"
    ) {
      return false;
    }

    const previousWidth = canvas.width;
    const previousHeight = canvas.height;
    canvas.width = width;
    canvas.height = height;
    try {
      rectangleRenderer.handleResize();
      glyphRenderer.handleResize();
      return true;
    } catch {
      canvas.width = previousWidth;
      canvas.height = previousHeight;
      try {
        rectangleRenderer.handleResize();
        glyphRenderer.handleResize();
      } catch {
        // The normal xterm resize path remains the final recovery boundary.
      }
      return false;
    }
  } catch {
    // Private renderer details can change between compatible addon releases.
    // The next normal xterm resize remains the source of truth.
    return false;
  }
}
