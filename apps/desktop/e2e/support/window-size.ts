export interface DesktopUiWindowSize {
  readonly width: number;
  readonly height: number;
}

export function scaleDesktopUiWindowSize(
  size: DesktopUiWindowSize,
  devicePixelRatio: number,
): DesktopUiWindowSize {
  const scale = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return {
    width: Math.ceil(size.width * scale),
    height: Math.ceil(size.height * scale),
  };
}

export function correctDesktopUiOuterSize(
  currentOuterSize: DesktopUiWindowSize,
  requestedViewportSize: DesktopUiWindowSize,
  observedViewportSize: DesktopUiWindowSize,
  devicePixelRatio: number,
): DesktopUiWindowSize {
  const scale = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return {
    width: Math.max(
      1,
      currentOuterSize.width +
        Math.ceil((requestedViewportSize.width - observedViewportSize.width) * scale),
    ),
    height: Math.max(
      1,
      currentOuterSize.height +
        Math.ceil((requestedViewportSize.height - observedViewportSize.height) * scale),
    ),
  };
}
