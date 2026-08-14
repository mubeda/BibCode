import { isDesktopHost } from "../env";
import {
  createEnvironmentPresentationPolicy,
  normalizeDesktopHostPlatform,
  type EnvironmentPresentationPolicy,
} from "./environmentPresentationPolicy";

export function readCurrentEnvironmentPresentationPolicy(): EnvironmentPresentationPolicy {
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  return createEnvironmentPresentationPolicy({
    surface: isDesktopHost ? "desktop" : "browser",
    platform: normalizeDesktopHostPlatform(platform),
  });
}
