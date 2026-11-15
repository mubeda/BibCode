import { createContext, useContext } from "react";

/**
 * Whether the center-panel surface a component renders in is the one the person can see. A
 * hidden surface stays mounted when it is the host chat, so mounting says nothing about being
 * seen. Outside a center panel the surface is always visible.
 */
export const CenterSurfaceVisibleContext = createContext(true);

export function useCenterSurfaceVisible(): boolean {
  return useContext(CenterSurfaceVisibleContext);
}
