import type { AdvertisedEndpoint, DesktopServerExposureState } from "@bibcode/contracts";
import { normalizeHttpBaseUrl } from "@bibcode/shared/advertisedEndpoint";

import { shareClassForPairingEndpoint } from "./endpointClass.ts";

export type ShareIntent = "another-device" | "this-computer" | "custom";

export interface ShareAddressOption {
  readonly id: string;
  readonly label: string;
  readonly httpBaseUrl: string | null;
  readonly description?: string;
}

export function buildPairDeepLink(code: string): string {
  return `bibcode://pair?code=${encodeURIComponent(code)}`;
}

export function buildBrowserPairUrl(endpoint: string, code: string): string {
  const url = new URL(endpoint);
  url.pathname = "/pair";
  url.search = "";
  url.searchParams.set("code", code);
  url.hash = "";
  return url.toString();
}

export function resolveShareAddressOptions(input: {
  readonly intent: ShareIntent;
  readonly advertisedEndpoints: ReadonlyArray<AdvertisedEndpoint>;
  readonly exposureState: DesktopServerExposureState | null;
  readonly primaryHttpBaseUrl: string | null;
}): ReadonlyArray<ShareAddressOption> {
  if (input.intent === "this-computer") {
    return input.primaryHttpBaseUrl === null
      ? []
      : [
          {
            id: "primary",
            label: "This computer",
            httpBaseUrl: input.primaryHttpBaseUrl,
            description: "Only clients on this machine (or a tunnel into it) can use this offer.",
          },
        ];
  }

  if (input.intent === "custom") {
    return [{ id: "custom", label: "Custom address", httpBaseUrl: null }];
  }

  const options: ShareAddressOption[] = [
    {
      id: "auto-lan",
      label: "Automatic (LAN)",
      httpBaseUrl: input.exposureState === null ? input.primaryHttpBaseUrl : null,
      description:
        input.exposureState?.endpointUrl === null
          ? "BiBCode will enable remote access and choose a LAN address."
          : "Use the LAN address selected by BiBCode.",
    },
  ];
  const seen = new Set<string>();
  for (const endpoint of input.advertisedEndpoints) {
    if (
      endpoint.status !== "available" ||
      shareClassForPairingEndpoint(endpoint.httpBaseUrl) !== "off-host" ||
      seen.has(endpoint.httpBaseUrl)
    ) {
      continue;
    }
    seen.add(endpoint.httpBaseUrl);
    options.push({
      id: endpoint.id,
      label: endpoint.label,
      httpBaseUrl: endpoint.httpBaseUrl,
      ...(endpoint.description === undefined ? {} : { description: endpoint.description }),
    });
  }
  return options;
}

export type GenerateShareOfferFailure =
  | { readonly kind: "invalid-address"; readonly message: string }
  | { readonly kind: "widen-failed"; readonly message: string }
  | { readonly kind: "mint-failed"; readonly message: string; readonly widened: boolean };

export interface GeneratedShareOffer {
  readonly code: string;
  readonly deepLink: string;
  readonly browserUrl: string;
  readonly endpoint: string;
  readonly name: string;
  readonly expiresAt: string;
  readonly reach: ShareIntent;
  readonly endpointClass: "loopback" | "off-host";
}

export interface GenerateShareOfferDeps {
  readonly intent: ShareIntent;
  readonly name: string;
  readonly customAddress: string | null;
  readonly selectedOption: ShareAddressOption;
  readonly hasDesktopBridge: boolean;
  readonly exposureState: DesktopServerExposureState | null;
  readonly applyServerExposure:
    | ((desired: "local-only" | "network-accessible") => Promise<DesktopServerExposureState>)
    | null;
  readonly mintOffer: (input: {
    name: string;
    endpoint: string;
    reach: ShareIntent;
    idempotencyKey: string;
  }) => Promise<{ code: string; endpoint: string; name: string; expiresAt: string }>;
  readonly newIdempotencyKey: () => string;
  readonly classifyMintError: (error: unknown) => "retryable" | "fatal";
  readonly sleep: (ms: number) => Promise<void>;
}

function resolveOfferEndpoint(deps: GenerateShareOfferDeps): string | null {
  if (deps.intent === "custom") {
    const customAddress = deps.customAddress?.trim();
    if (!customAddress) throw new Error("Enter a valid http(s) address.");
    try {
      return normalizeHttpBaseUrl(customAddress);
    } catch {
      throw new Error("Enter a valid http(s) address.");
    }
  }
  return deps.selectedOption.httpBaseUrl;
}

export async function generateShareOffer(
  deps: GenerateShareOfferDeps,
): Promise<
  { ok: true; offer: GeneratedShareOffer } | { ok: false; failure: GenerateShareOfferFailure }
> {
  let endpoint: string | null;
  try {
    endpoint = resolveOfferEndpoint(deps);
  } catch (error) {
    return {
      ok: false,
      failure: {
        kind: "invalid-address",
        message: error instanceof Error ? error.message : "Enter a valid http(s) address.",
      },
    };
  }

  const endpointClassForWiden =
    deps.intent === "another-device"
      ? "off-host"
      : deps.intent === "custom" && endpoint !== null
        ? shareClassForPairingEndpoint(endpoint)
        : "loopback";
  if (endpointClassForWiden === "unconnectable") {
    return {
      ok: false,
      failure: {
        kind: "invalid-address",
        message: "This address is not reachable as entered. Check the host and port.",
      },
    };
  }

  let widened = false;
  if (
    endpointClassForWiden === "off-host" &&
    deps.hasDesktopBridge &&
    deps.applyServerExposure !== null &&
    deps.exposureState?.mode !== "network-accessible"
  ) {
    try {
      const state = await deps.applyServerExposure("network-accessible");
      widened = true;
      if (endpoint === null) endpoint = state.endpointUrl;
    } catch (error) {
      return {
        ok: false,
        failure: {
          kind: "widen-failed",
          message: error instanceof Error ? error.message : "Could not enable remote access.",
        },
      };
    }
  }

  if (endpoint === null) endpoint = deps.exposureState?.endpointUrl ?? null;
  if (endpoint === null) {
    return {
      ok: false,
      failure: { kind: "widen-failed", message: "No reachable network address is available." },
    };
  }

  const idempotencyKey = deps.newIdempotencyKey();
  const maxMintAttempts = 5;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < maxMintAttempts; attempt += 1) {
    if (attempt > 0) await deps.sleep(2_000);
    try {
      const minted = await deps.mintOffer({
        name: deps.name,
        endpoint,
        reach: deps.intent,
        idempotencyKey,
      });
      const endpointClass = shareClassForPairingEndpoint(minted.endpoint);
      return {
        ok: true,
        offer: {
          code: minted.code,
          deepLink: buildPairDeepLink(minted.code),
          browserUrl: buildBrowserPairUrl(minted.endpoint, minted.code),
          endpoint: minted.endpoint,
          name: minted.name,
          expiresAt: minted.expiresAt,
          reach: deps.intent,
          endpointClass: endpointClass === "unconnectable" ? "off-host" : endpointClass,
        },
      };
    } catch (error) {
      lastError = error;
      if (deps.classifyMintError(error) === "fatal") break;
    }
  }

  return {
    ok: false,
    failure: {
      kind: "mint-failed",
      widened,
      message:
        lastError instanceof Error ? lastError.message : "Could not create the pairing offer.",
    },
  };
}
