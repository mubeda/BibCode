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
