import type {
  AdvertisedEndpoint,
  AdvertisedEndpointHostedHttpsCompatibility,
  AdvertisedEndpointProvider,
  AdvertisedEndpointReachability,
  AdvertisedEndpointSource,
  AdvertisedEndpointStatus,
} from "@bibcode/contracts";

export interface CreateAdvertisedEndpointInput {
  readonly id: string;
  readonly label: string;
  readonly provider: AdvertisedEndpointProvider;
  readonly httpBaseUrl: string;
  readonly reachability: AdvertisedEndpointReachability;
  readonly hostedHttpsCompatibility?: AdvertisedEndpointHostedHttpsCompatibility;
  readonly desktopCompatibility?: "compatible" | "unknown";
  readonly source: AdvertisedEndpointSource;
  readonly status?: AdvertisedEndpointStatus;
  readonly isDefault?: boolean;
  readonly description?: string;
}

export function normalizeHttpBaseUrl(rawValue: string): string {
  const url = new URL(rawValue);
  if (url.protocol === "ws:") {
    url.protocol = "http:";
  } else if (url.protocol === "wss:") {
    url.protocol = "https:";
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Endpoint must use HTTP or HTTPS. Received ${url.protocol}`);
  }

  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function deriveWsBaseUrl(httpBaseUrl: string): string {
  const url = new URL(normalizeHttpBaseUrl(httpBaseUrl));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function classifyHostedHttpsCompatibility(
  httpBaseUrl: string,
  fallback: AdvertisedEndpointHostedHttpsCompatibility = "unknown",
): AdvertisedEndpointHostedHttpsCompatibility {
  const url = new URL(normalizeHttpBaseUrl(httpBaseUrl));
  if (url.protocol === "http:") {
    return "mixed-content-blocked";
  }
  return fallback === "mixed-content-blocked" ? "unknown" : fallback;
}

export type PairingEndpointClassification =
  | "loopback"
  | "private-network"
  | "public"
  | "unconnectable";

function isPrivateIpv4(host: string): boolean {
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => Number.isNaN(octet))) {
    return false;
  }
  const [a, b] = octets as [number, number, number, number];
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254)
  );
}

export function classifyPairingEndpoint(endpoint: string): PairingEndpointClassification {
  let url: URL;
  try {
    url = new URL(normalizeHttpBaseUrl(endpoint));
  } catch {
    return "unconnectable";
  }
  if (/:0(?:[/?#]|$)/.test(endpoint.trim())) {
    return "unconnectable";
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "0.0.0.0" || host === "::" || host === "") {
    return "unconnectable";
  }
  if (host === "localhost" || host === "::1" || host.startsWith("127.")) {
    return "loopback";
  }
  if (isPrivateIpv4(host)) {
    return "private-network";
  }
  if (host.startsWith("fd") || host.startsWith("fc") || host.startsWith("fe80")) {
    return "private-network";
  }
  return "public";
}

export function createAdvertisedEndpoint(input: CreateAdvertisedEndpointInput): AdvertisedEndpoint {
  const httpBaseUrl = normalizeHttpBaseUrl(input.httpBaseUrl);
  return {
    id: input.id,
    label: input.label,
    provider: input.provider,
    httpBaseUrl,
    wsBaseUrl: deriveWsBaseUrl(httpBaseUrl),
    reachability: input.reachability,
    compatibility: {
      hostedHttpsApp:
        input.hostedHttpsCompatibility ?? classifyHostedHttpsCompatibility(httpBaseUrl),
      desktopApp: input.desktopCompatibility ?? "compatible",
    },
    source: input.source,
    status: input.status ?? "available",
    ...(input.isDefault === undefined ? {} : { isDefault: input.isDefault }),
    ...(input.description === undefined ? {} : { description: input.description }),
  };
}
