import {
  readHostedPairingRequest as readNormalizedHostedPairingRequest,
  type HostedPairingRequest,
} from "@bibcode/shared/remote";

import { setPairingTokenOnUrl } from "./pairingUrl";

export type { HostedPairingRequest };

export type HostedAppChannel = "latest" | "nightly";

export function configuredHostedAppUrl(): string {
  const configured = import.meta.env.VITE_HOSTED_APP_URL?.trim();
  if (configured) return configured;

  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return origin && origin !== "null" ? origin : "http://localhost";
}

function configuredBackendUrl(): string {
  return import.meta.env.VITE_HTTP_URL?.trim() || import.meta.env.VITE_WS_URL?.trim() || "";
}

function configuredHostedAppChannel(): HostedAppChannel | null {
  const channel = import.meta.env.VITE_HOSTED_APP_CHANNEL?.trim().toLowerCase();
  return channel === "latest" || channel === "nightly" ? channel : null;
}

function originFromUrl(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function isHostedStaticApp(url: URL = new URL(window.location.href)): boolean {
  if (typeof window !== "undefined" && window.desktopBridge !== undefined) {
    return false;
  }

  if (configuredBackendUrl()) {
    return false;
  }

  if (configuredHostedAppChannel()) {
    return true;
  }

  const hostedOrigin = originFromUrl(configuredHostedAppUrl());
  return hostedOrigin !== null && url.origin === hostedOrigin;
}

export function readHostedPairingRequest(url: URL = new URL(window.location.href)) {
  return readNormalizedHostedPairingRequest(url);
}

export function hasHostedPairingRequest(url: URL = new URL(window.location.href)): boolean {
  return readHostedPairingRequest(url) !== null;
}

export function buildHostedPairingUrl(input: {
  readonly host: string;
  readonly token: string;
  readonly label?: string | null;
}): string {
  const url = new URL("/pair", configuredHostedAppUrl());
  url.searchParams.set("host", input.host);

  const label = input.label?.trim();
  if (label) {
    url.searchParams.set("label", label);
  }

  return setPairingTokenOnUrl(url, input.token).toString();
}

export function buildHostedChannelSelectionUrl(input: {
  readonly channel: HostedAppChannel;
}): string {
  const url = new URL("/__bibcode/channel", configuredHostedAppUrl());
  url.searchParams.set("channel", input.channel);
  return url.toString();
}
