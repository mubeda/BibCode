import type { ScopedThreadRef } from "@bibcode/contracts";

import {
  selectThreadCenterPanelState,
  type ThreadCenterPanelState,
  useCenterPanelStore,
} from "./centerPanelStore";
import {
  selectThreadRightPanelState,
  type ThreadRightPanelState,
  useRightPanelStore,
} from "./rightPanelStore";

export function selectThreadHasTerminalSurface(
  centerByThreadKey: Record<string, ThreadCenterPanelState>,
  rightByThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): boolean {
  const centerState = selectThreadCenterPanelState(centerByThreadKey, ref);
  const rightState = selectThreadRightPanelState(rightByThreadKey, ref);
  return (
    centerState.surfaces.some((surface) => surface.kind === "terminal") ||
    rightState.surfaces.some((surface) => surface.kind === "terminal")
  );
}

export function useThreadHasTerminalSurface(ref: ScopedThreadRef | null | undefined): boolean {
  const centerByThreadKey = useCenterPanelStore((state) => state.byThreadKey);
  const rightByThreadKey = useRightPanelStore((state) => state.byThreadKey);
  return selectThreadHasTerminalSurface(centerByThreadKey, rightByThreadKey, ref);
}
