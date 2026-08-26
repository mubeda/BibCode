import type { ConnectionTarget } from "@bibcode/client-runtime/connection";

import { isLinuxPlatform, isMacPlatform, isWindowsPlatform } from "../lib/utils";

export type ClientPresentationSurface = "browser" | "desktop";
export type DesktopHostPlatform = "macos" | "windows" | "linux" | "unknown";
export type ConnectionsPresentation = "full" | "local-wsl" | "redirect-general";

export interface EnvironmentPresentationPolicy {
  readonly surface: ClientPresentationSurface;
  readonly platform: DesktopHostPlatform;
  readonly connectionsPresentation: ConnectionsPresentation;
  readonly showRemoteDeviceControls: boolean;
  readonly showLocalEnvironmentSettings: boolean;
  readonly presentsTarget: (target: ConnectionTarget) => boolean;
  readonly permitsConnectionAction: (target: ConnectionTarget) => boolean;
}

export function normalizeDesktopHostPlatform(platform: string): DesktopHostPlatform {
  if (isMacPlatform(platform)) {
    return "macos";
  }
  if (isWindowsPlatform(platform)) {
    return "windows";
  }
  if (isLinuxPlatform(platform)) {
    return "linux";
  }
  return "unknown";
}

export function createEnvironmentPresentationPolicy(input: {
  readonly surface: ClientPresentationSurface;
  readonly platform: DesktopHostPlatform;
}): EnvironmentPresentationPolicy {
  const connectionsPresentation = "full";
  const presentsTarget = (_target: ConnectionTarget) => true;

  return {
    ...input,
    connectionsPresentation,
    showRemoteDeviceControls: true,
    showLocalEnvironmentSettings: false,
    presentsTarget,
    permitsConnectionAction: presentsTarget,
  };
}
