import type {
  BrowserNavigationTarget,
  EnvironmentId,
  PreviewUrlResolution,
} from "@bibcode/contracts";
import { normalizePreviewUrl } from "@bibcode/shared/preview";

import { readPreparedConnection } from "~/state/session";

const isPrivateNetworkHost = (host: string): boolean => {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1" || normalized.endsWith(".local")) {
    return true;
  }
  if (normalized.endsWith(".ts.net")) return true;
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd][0-9a-f]{2}:/.test(normalized) || /^fe[89ab][0-9a-f]:/.test(normalized)) return true;
  const parts = normalized.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  return (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127) || // tailnet CGNAT 100.64.0.0/10
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254)
  );
};

const unbracket = (host: string) => host.toLowerCase().replace(/^\[|\]$/g, "");

/** Any address that names the machine it is resolved on, including wildcard binds. */
const isLoopbackHost = (hostname: string): boolean => {
  const host = unbracket(hostname);
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    /^127\.\d+\.\d+\.\d+$/.test(host) ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "::"
  );
};

const isWildcardHost = (hostname: string) => {
  const host = unbracket(hostname);
  return host === "0.0.0.0" || host === "::";
};

const isIpLiteral = (host: string) => host.includes(":") || /^\d+\.\d+\.\d+\.\d+$/.test(host);

const parseUrl = (raw: string): URL | null => {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
};

const parsePreviewUrl = (raw: string): URL | null => {
  try {
    return new URL(normalizePreviewUrl(raw));
  } catch {
    return null;
  }
};

export type PreviewUnreachableReason = "disconnected" | "ssh" | "relay" | "public-host";
export type PreviewTargetResolution =
  | { readonly kind: "reachable"; readonly url: string }
  | {
      readonly kind: "unreachable";
      readonly reason: PreviewUnreachableReason;
      readonly environmentLabel: string;
      /** The normalized address that could not be opened. */
      readonly url: string;
    };

const UNREACHABLE_REMOTE = (label: string) =>
  `This address is on ${label}, not this computer. Opening its ports from here isn't supported yet.`;

export const UNREACHABLE_MESSAGES: Record<PreviewUnreachableReason, (label: string) => string> = {
  disconnected: (label) => `${label} isn't connected. Reconnect it, then open the link again.`,
  ssh: UNREACHABLE_REMOTE,
  relay: UNREACHABLE_REMOTE,
  "public-host": UNREACHABLE_REMOTE,
};

type EnvironmentReach =
  | { readonly kind: "same-host" }
  | { readonly kind: "host"; readonly host: string }
  | {
      readonly kind: "unreachable";
      readonly reason: PreviewUnreachableReason;
      readonly label: string;
    };

// The connection target alone never decides "same machine": a primary can be a
// browser served by a remote host, and desktop-local WSL is a bearer target on
// the VM address. SSH and relay endpoints are never the environment's own host.
function classifyEnvironmentReach(environmentId: EnvironmentId): EnvironmentReach {
  const connection = readPreparedConnection(environmentId);
  if (!connection) {
    return { kind: "unreachable", reason: "disconnected", label: "This environment" };
  }
  const label = connection.label;
  const baseUrl = parseUrl(connection.httpBaseUrl);
  if (!baseUrl) return { kind: "unreachable", reason: "disconnected", label };
  if (connection.target._tag === "SshConnectionTarget") {
    return { kind: "unreachable", reason: "ssh", label };
  }
  if (connection.target._tag === "RelayConnectionTarget") {
    return { kind: "unreachable", reason: "relay", label };
  }
  const host = unbracket(baseUrl.hostname);
  if (isLoopbackHost(host)) return { kind: "same-host" };
  // A host name (devbox, *.lan, *.internal) is the user's own name for the
  // machine; only a public IP literal is known to be off the private network.
  if (!isIpLiteral(host) || isPrivateNetworkHost(host)) return { kind: "host", host };
  return { kind: "unreachable", reason: "public-host", label };
}

const formatHost = (host: string) => (host.includes(":") ? `[${host}]` : host);

export function resolveBrowserNavigationTarget(
  environmentId: EnvironmentId,
  target: BrowserNavigationTarget,
): PreviewUrlResolution {
  if (target.kind === "url") {
    const resolution = resolvePreviewTarget(environmentId, target.url);
    if (resolution.kind === "unreachable") {
      throw new Error(UNREACHABLE_MESSAGES[resolution.reason](resolution.environmentLabel));
    }
    const requestedHost = parsePreviewUrl(target.url)?.hostname;
    const resolvedHost = parseUrl(resolution.url)?.hostname;
    const rewritten =
      requestedHost !== undefined &&
      resolvedHost !== undefined &&
      isLoopbackHost(requestedHost) &&
      !isLoopbackHost(resolvedHost);
    return {
      requestedUrl: target.url,
      resolvedUrl: resolution.url,
      resolutionKind: rewritten ? "direct-private-network" : "direct",
      environmentId,
    };
  }
  const reach = classifyEnvironmentReach(environmentId);
  if (reach.kind === "unreachable") {
    throw new Error(UNREACHABLE_MESSAGES[reach.reason](reach.label));
  }
  const protocol = target.protocol ?? "http";
  const path = target.path?.startsWith("/") ? target.path : `/${target.path ?? ""}`;
  const requestedUrl = `${protocol}://localhost:${target.port}${path}`;
  if (reach.kind === "same-host") {
    return { requestedUrl, resolvedUrl: requestedUrl, resolutionKind: "direct", environmentId };
  }
  const resolved = new URL(path, `${protocol}://${formatHost(reach.host)}:${target.port}`);
  return {
    requestedUrl,
    resolvedUrl: resolved.toString(),
    resolutionKind: "direct-private-network",
    environmentId,
  };
}

export function resolvePreviewTarget(
  environmentId: EnvironmentId,
  rawUrl: string,
): PreviewTargetResolution {
  const parsed = parsePreviewUrl(rawUrl);
  // Malformed input keeps the normal navigation error path.
  if (!parsed) return { kind: "reachable", url: rawUrl };
  if (!isLoopbackHost(parsed.hostname)) return { kind: "reachable", url: parsed.toString() };
  // The server's own origin (e.g. an SSH-forwarded asset URL) is already reachable.
  const serverUrl = readPreparedConnection(environmentId)?.httpBaseUrl;
  if (serverUrl !== undefined && parseUrl(serverUrl)?.origin === parsed.origin) {
    return { kind: "reachable", url: parsed.toString() };
  }
  const reach = classifyEnvironmentReach(environmentId);
  if (reach.kind === "unreachable") {
    return {
      kind: "unreachable",
      reason: reach.reason,
      environmentLabel: reach.label,
      url: parsed.toString(),
    };
  }
  if (reach.kind === "host") {
    parsed.hostname = formatHost(reach.host);
  } else if (isWildcardHost(parsed.hostname)) {
    // A wildcard bind is not a navigable address; loopback is.
    parsed.hostname = "localhost";
  }
  return { kind: "reachable", url: parsed.toString() };
}
