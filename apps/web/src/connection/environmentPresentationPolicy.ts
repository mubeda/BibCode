import type { ConnectionTarget } from "@bibcode/client-runtime/connection";

import { isDesktopLocalConnectionTarget } from "./desktopLocal";
import { isLinuxPlatform, isMacPlatform, isWindowsPlatform } from "../lib/utils";

export type ClientPresentationSurface = "browser" | "desktop";
export type DesktopHostPlatform = "macos" | "windows" | "linux" | "unknown";

export interface EnvironmentPresentationPolicy {
  readonly surface: ClientPresentationSurface;
  readonly platform: DesktopHostPlatform;
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

function isLocalDesktopTarget(
  policy: Pick<EnvironmentPresentationPolicy, "surface" | "platform">,
  target: ConnectionTarget,
): boolean {
  if (target._tag === "PrimaryConnectionTarget") {
    return true;
  }
  return (
    policy.surface === "desktop" &&
    policy.platform === "windows" &&
    isDesktopLocalConnectionTarget(target)
  );
}

export function createEnvironmentPresentationPolicy(input: {
  readonly surface: ClientPresentationSurface;
  readonly platform: DesktopHostPlatform;
}): EnvironmentPresentationPolicy {
  const browser = input.surface === "browser";
  const presentsTarget = (target: ConnectionTarget) =>
    browser || isLocalDesktopTarget(input, target);

  return {
    ...input,
    showRemoteDeviceControls: browser,
    showLocalEnvironmentSettings: input.surface === "desktop" && input.platform === "windows",
    presentsTarget,
    permitsConnectionAction: presentsTarget,
  };
}
