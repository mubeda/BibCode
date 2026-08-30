import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthReviewWriteScope,
  AuthTerminalOperateScope,
  type AuthClientSession,
  type AuthEnvironmentScope,
  type AuthPairingLink,
  type AdvertisedEndpoint,
  type DesktopDiscoveredSshHost,
  type DesktopSshEnvironmentTarget,
} from "@bibcode/contracts";
import * as DateTime from "effect/DateTime";

import { cn } from "../../../lib/utils";
import { resolveDesktopPairingUrl, resolveHostedPairingUrl } from "./pairingUrls";
import { getPairingTokenFromUrl, setPairingTokenOnUrl } from "../../../pairingUrl";
import { readHostedPairingRequest } from "../../../hostedPairing";
import type { ServerClientSessionRecord, ServerPairingLinkRecord } from "~/environments/primary";
import { Popover, PopoverPopup, PopoverTrigger } from "../../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";

export const DEFAULT_TAILSCALE_SERVE_PORT = 443;
export const EMPTY_ADVERTISED_ENDPOINTS: ReadonlyArray<AdvertisedEndpoint> = [];
export const EMPTY_DISCOVERED_SSH_HOSTS: ReadonlyArray<DesktopDiscoveredSshHost> = [];

const accessTimestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function formatAccessTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return accessTimestampFormatter.format(parsed);
}

export const PAIRING_SCOPE_OPTIONS: ReadonlyArray<{
  readonly scope: AuthEnvironmentScope;
  readonly title: string;
  readonly description: string;
}> = [
  {
    scope: AuthOrchestrationReadScope,
    title: "View environment",
    description: "Read threads, status, diffs, and configuration.",
  },
  {
    scope: AuthOrchestrationOperateScope,
    title: "Operate tasks",
    description: "Start tasks and perform changes in the environment.",
  },
  {
    scope: AuthTerminalOperateScope,
    title: "Use terminals",
    description: "Create terminals and send input to running shells.",
  },
  {
    scope: AuthReviewWriteScope,
    title: "Write reviews",
    description: "Create comments while reviewing changes.",
  },
  {
    scope: AuthAccessReadScope,
    title: "View access",
    description: "Inspect pairing links and authorized clients.",
  },
  {
    scope: AuthAccessWriteScope,
    title: "Manage access",
    description: "Issue and revoke credentials for other clients.",
  },
  {
    scope: AuthRelayReadScope,
    title: "View relay",
    description: "Inspect managed relay connectivity.",
  },
  {
    scope: AuthRelayWriteScope,
    title: "Manage relay",
    description: "Change managed tunnel connectivity.",
  },
];

export function AccessScopeSummary({
  scopes,
  label,
}: {
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly label: string;
}) {
  const scopeCountLabel = `${scopes.length} ${scopes.length === 1 ? "scope" : "scopes"}`;

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={250}
        closeDelay={100}
        render={
          <button
            type="button"
            aria-label={`${label}: show ${scopeCountLabel}`}
            className="cursor-help underline decoration-border underline-offset-2 outline-hidden hover:text-foreground focus-visible:text-foreground"
          />
        }
      >
        {scopeCountLabel}
      </PopoverTrigger>
      <PopoverPopup
        side="top"
        align="start"
        tooltipStyle
        className="w-max max-w-80 whitespace-normal"
      >
        <p className="mb-1 font-medium">Granted scopes</p>
        <div className="flex flex-col gap-0.5">
          {scopes.map((scope) => (
            <code key={scope} className="font-mono text-foreground/85">
              {scope}
            </code>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

type ConnectionStatusDotProps = {
  tooltipText?: string | null;
  dotClassName: string;
  pingClassName?: string | null;
};

export function ConnectionStatusDot({
  tooltipText,
  dotClassName,
  pingClassName,
}: ConnectionStatusDotProps) {
  const dotContent = (
    <>
      {pingClassName ? (
        <span
          className={cn(
            "absolute inline-flex h-full w-full animate-ping rounded-full",
            pingClassName,
          )}
        />
      ) : null}
      <span className={cn("relative inline-flex size-2 rounded-full", dotClassName)} />
    </>
  );

  if (!tooltipText) {
    return (
      <span className="relative flex size-3 shrink-0 items-center justify-center">
        {dotContent}
      </span>
    );
  }

  const dot = (
    <button
      type="button"
      title={tooltipText}
      aria-label={tooltipText}
      className="relative flex size-3 shrink-0 cursor-help items-center justify-center rounded-full outline-hidden"
    >
      {dotContent}
    </button>
  );

  return (
    <Tooltip>
      <TooltipTrigger render={dot} />
      <TooltipPopup side="top" className="max-w-80 whitespace-pre-wrap leading-tight">
        {tooltipText}
      </TooltipPopup>
    </Tooltip>
  );
}

export function formatDesktopSshTarget(target: DesktopSshEnvironmentTarget): string {
  const authority = target.username ? `${target.username}@${target.hostname}` : target.hostname;
  return target.port ? `${authority}:${target.port}` : authority;
}

export function parseManualDesktopSshTarget(input: {
  readonly host: string;
  readonly username: string;
  readonly port: string;
}): DesktopSshEnvironmentTarget {
  const rawHost = input.host.trim();
  if (rawHost.length === 0) {
    throw new Error("SSH host or alias is required.");
  }

  let hostname = rawHost;
  let username = input.username.trim() || null;
  let port: number | null = null;

  const atIndex = hostname.lastIndexOf("@");
  if (atIndex > 0) {
    const inlineUsername = hostname.slice(0, atIndex).trim();
    hostname = hostname.slice(atIndex + 1).trim();
    if (!username && inlineUsername.length > 0) {
      username = inlineUsername;
    }
  }

  const bracketedHostMatch = /^\[([^\]]+)\](?::(\d+))?$/u.exec(hostname);
  if (bracketedHostMatch) {
    hostname = bracketedHostMatch[1]!.trim();
    if (bracketedHostMatch[2]) {
      port = Number.parseInt(bracketedHostMatch[2], 10);
    }
  } else {
    const colonSegments = hostname.split(":");
    if (colonSegments.length === 2 && /^\d+$/u.test(colonSegments[1] ?? "")) {
      hostname = colonSegments[0]!.trim();
      port = Number.parseInt(colonSegments[1]!, 10);
    }
  }

  const rawPort = input.port.trim();
  if (rawPort.length > 0) {
    port = Number.parseInt(rawPort, 10);
  }

  if (hostname.length === 0) {
    throw new Error("SSH host or alias is required.");
  }

  if (port !== null && (!Number.isInteger(port) || port <= 0 || port > 65_535)) {
    throw new Error("SSH port must be between 1 and 65535.");
  }

  return {
    alias: hostname,
    hostname,
    username,
    port,
  };
}

export function parsePairingUrlFields(
  input: string,
): { readonly host: string; readonly pairingCode: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  try {
    const urlLikeInput =
      /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//u.test(trimmed) || trimmed.startsWith("//")
        ? trimmed
        : `https://${trimmed}`;
    const url = new URL(urlLikeInput, window.location.origin);
    const hostedPairingRequest = readHostedPairingRequest(url);
    if (hostedPairingRequest) {
      return {
        host: hostedPairingRequest.httpBaseUrl,
        pairingCode: hostedPairingRequest.token,
      };
    }

    const pairingCode = getPairingTokenFromUrl(url);
    if (!pairingCode) return null;
    return {
      host: url.origin,
      pairingCode,
    };
  } catch {
    return null;
  }
}

export function parseRemotePairingFields(input: {
  readonly host: string;
  readonly pairingCode: string;
}): {
  readonly host: string;
  readonly pairingCode: string;
} {
  const parsedPairingUrl = parsePairingUrlFields(input.host);
  if (parsedPairingUrl) return parsedPairingUrl;

  const host = input.host.trim();
  const pairingCode = input.pairingCode.trim();
  if (!host) {
    throw new Error("Enter a backend host.");
  }
  if (!pairingCode) {
    throw new Error("Enter a pairing code.");
  }
  return { host, pairingCode };
}

export function formatDesktopSshConnectionError(error: unknown): string {
  const fallback = "Failed to connect SSH host.";
  const rawMessage = error instanceof Error ? error.message : fallback;
  const withoutIpcPrefix = rawMessage.replace(
    /^Error invoking remote method 'desktop:ensure-ssh-environment':\s*/u,
    "",
  );
  const withoutTaggedErrorPrefix = withoutIpcPrefix.replace(/^Ssh[A-Za-z]+Error:\s*/u, "");
  return withoutTaggedErrorPrefix.trim() || fallback;
}

/** Direct row in the card – same pattern as the Provider / ACP-agent list rows. */
export const ITEM_ROW_CLASSNAME = "border-t border-border/60 px-4 py-4 first:border-t-0 sm:px-5";
export const ENDPOINT_ROW_CLASSNAME =
  "border-t border-border/60 px-4 py-2.5 first:border-t-0 sm:px-5";

export const ITEM_ROW_INNER_CLASSNAME =
  "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between";

export type AccessSectionPresentation = "current" | "endpoint-rail";

export function accessRowClassName(_presentation: AccessSectionPresentation) {
  return ITEM_ROW_CLASSNAME;
}

export function endpointRowClassName(
  presentation: AccessSectionPresentation,
  isAvailable: boolean,
) {
  if (presentation === "endpoint-rail") {
    return cn(
      "relative border-t border-border/60 px-4 py-3 first:border-t-0 sm:px-5",
      !isAvailable && "bg-muted/20",
    );
  }

  return cn(ENDPOINT_ROW_CLASSNAME, !isAvailable && "bg-muted/24");
}

export function sortDesktopPairingLinks(links: ReadonlyArray<ServerPairingLinkRecord>) {
  return [...links].toSorted(
    (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  );
}

export function sortDesktopClientSessions(sessions: ReadonlyArray<ServerClientSessionRecord>) {
  return [...sessions].toSorted((left, right) => {
    if (left.current !== right.current) {
      return left.current ? -1 : 1;
    }
    if (left.connected !== right.connected) {
      return left.connected ? -1 : 1;
    }
    return new Date(right.issuedAt).getTime() - new Date(left.issuedAt).getTime();
  });
}

export function toDesktopPairingLinkRecord(pairingLink: AuthPairingLink): ServerPairingLinkRecord {
  return {
    ...pairingLink,
    createdAt: DateTime.formatIso(pairingLink.createdAt),
    expiresAt: DateTime.formatIso(pairingLink.expiresAt),
  };
}

export function toDesktopClientSessionRecord(
  clientSession: AuthClientSession,
): ServerClientSessionRecord {
  return {
    ...clientSession,
    issuedAt: DateTime.formatIso(clientSession.issuedAt),
    expiresAt: DateTime.formatIso(clientSession.expiresAt),
    lastConnectedAt:
      clientSession.lastConnectedAt === null
        ? null
        : DateTime.formatIso(clientSession.lastConnectedAt),
  };
}

export function selectPairingEndpoint(
  endpoints: ReadonlyArray<AdvertisedEndpoint>,
  defaultEndpointKey?: string | null,
): AdvertisedEndpoint | null {
  const availableEndpoints = endpoints.filter((endpoint) => endpoint.status !== "unavailable");
  if (defaultEndpointKey) {
    const selectedEndpoint = availableEndpoints.find(
      (endpoint) => endpointDefaultPreferenceKey(endpoint) === defaultEndpointKey,
    );
    if (selectedEndpoint) {
      return selectedEndpoint;
    }
  }
  return (
    availableEndpoints.find((endpoint) => endpoint.isDefault) ??
    availableEndpoints.find((endpoint) => endpoint.reachability !== "loopback") ??
    availableEndpoints.find((endpoint) => endpoint.compatibility.hostedHttpsApp === "compatible") ??
    null
  );
}

export function isTailscaleHttpsEndpoint(endpoint: AdvertisedEndpoint): boolean {
  return endpoint.id.startsWith("tailscale-magicdns:");
}

export function endpointDefaultPreferenceKey(endpoint: AdvertisedEndpoint): string {
  if (endpoint.id.startsWith("desktop-loopback:")) {
    return "desktop-core:loopback:http";
  }
  if (endpoint.id.startsWith("desktop-lan:")) {
    return "desktop-core:lan:http";
  }
  if (endpoint.id.startsWith("tailscale-ip:")) {
    return "tailscale:ip:http";
  }
  if (isTailscaleHttpsEndpoint(endpoint)) {
    return "tailscale:magicdns:https";
  }

  let scheme = "unknown";
  try {
    scheme = new URL(endpoint.httpBaseUrl).protocol.replace(/:$/u, "");
  } catch {
    // Keep the stored preference stable even if a custom endpoint is malformed.
  }

  return `${endpoint.provider.id}:${endpoint.reachability}:${scheme}:${endpoint.label}`;
}

export function resolveAdvertisedEndpointPairingUrl(
  endpoint: AdvertisedEndpoint,
  credential: string,
): string {
  if (endpoint.compatibility.hostedHttpsApp === "compatible") {
    return (
      resolveHostedPairingUrl(endpoint.httpBaseUrl, credential) ??
      resolveDesktopPairingUrl(endpoint.httpBaseUrl, credential)
    );
  }
  return resolveDesktopPairingUrl(endpoint.httpBaseUrl, credential);
}

export function resolveCurrentOriginPairingUrl(credential: string): string {
  const url = new URL("/pair", window.location.href);
  return setPairingTokenOnUrl(url, credential).toString();
}

export function isHostedAppPairingUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.pathname === "/pair" && url.searchParams.has("host");
  } catch {
    return false;
  }
}

/** @internal Deterministic connection helpers shared with the focused unit-test suite. */
export const remoteServersSettingsInternals = {
  endpointDefaultPreferenceKey,
  endpointRowClassName,
  formatAccessTimestamp,
  formatDesktopSshConnectionError,
  formatDesktopSshTarget,
  isHostedAppPairingUrl,
  isTailscaleHttpsEndpoint,
  parseManualDesktopSshTarget,
  parsePairingUrlFields,
  parseRemotePairingFields,
  resolveAdvertisedEndpointPairingUrl,
  selectPairingEndpoint,
  sortDesktopClientSessions,
  sortDesktopPairingLinks,
  toDesktopClientSessionRecord,
  toDesktopPairingLinkRecord,
};
