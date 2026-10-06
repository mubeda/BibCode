// @effect-diagnostics nodeBuiltinImport:off - Only the owning contracts Schema runtime decodes native bridge reads.
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import {
  DesktopBridgeHostMetadataSchema,
  DesktopServerExposureStateSchema,
} from "../../../../packages/contracts/src/ipc.ts";
import { AdvertisedEndpoint as AdvertisedEndpointSchema } from "../../../../packages/contracts/src/remoteAccess.ts";
import { ExecutionEnvironmentDescriptor as DescriptorSchema } from "../../../../packages/contracts/src/environment.ts";
import type { QualificationBrowser } from "./qualification-owner.ts";
import type {
  DesktopBridgeHostMetadata,
  DesktopServerExposureState,
} from "../../../../packages/contracts/src/ipc.ts";
import type { AdvertisedEndpoint } from "../../../../packages/contracts/src/remoteAccess.ts";
import type { ExecutionEnvironmentDescriptor } from "../../../../packages/contracts/src/environment.ts";
export interface NativeSharingIdentityInput {
  readonly metadata: DesktopBridgeHostMetadata;
  readonly exposure: DesktopServerExposureState;
  readonly endpoints: readonly AdvertisedEndpoint[];
  readonly descriptor: ExecutionEnvironmentDescriptor;
  readonly endpoint: string;
}
export interface NativeSharingIdentityPin {
  readonly bootId: string;
  readonly storageInstanceId: string;
  readonly serverVersion: string;
  readonly endpoint: string;
}
export function validateNativeSharingIdentity(
  input: NativeSharingIdentityInput,
  pin: NativeSharingIdentityPin,
  route: "owned" | "absent",
): Record<string, true> {
  const refused = () => new Error("Owned native sharing identity refused.");
  if (route !== "owned" && route !== "absent") throw refused();
  const endpoint = new URL(input.endpoint);
  if (
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !["", "/"].includes(endpoint.pathname) ||
    input.endpoint !== pin.endpoint
  )
    throw refused();
  if (
    !pin.bootId ||
    !pin.storageInstanceId ||
    !pin.serverVersion ||
    input.descriptor.environmentId !== "primary" ||
    input.descriptor.platform.os !== "linux" ||
    input.descriptor.bootId !== pin.bootId ||
    input.descriptor.storageInstanceId !== pin.storageInstanceId ||
    input.descriptor.serverVersion !== pin.serverVersion
  )
    throw refused();
  if (
    input.metadata.host !== "tauri" ||
    input.metadata.bridgeVersion !== 3 ||
    input.metadata.features.localBackend !== true ||
    input.metadata.features.serverExposure !== true ||
    input.metadata.features.clientSettings !== true
  )
    throw refused();
  const exposure = input.exposure;
  if (
    exposure.management !== "native" ||
    exposure.mode !== "local-only" ||
    exposure.configuredMode !== "local-only" ||
    exposure.endpointUrl !== null ||
    exposure.advertisedHost !== null ||
    exposure.tailscaleServeEnabled !== false
  )
    throw refused();
  if (
    input.endpoints.length > 8 ||
    new Set(input.endpoints.map((value) => value.id)).size !== input.endpoints.length
  )
    throw refused();
  for (const value of input.endpoints) {
    const http = new URL(value.httpBaseUrl),
      websocket = new URL(value.wsBaseUrl);
    if (
      value.source !== "desktop-core" ||
      value.provider.id !== "desktop-core" ||
      value.provider.kind !== "core" ||
      value.provider.isAddon !== false ||
      http.protocol !== "http:" ||
      websocket.protocol !== "ws:" ||
      http.host !== websocket.host ||
      http.port !== endpoint.port ||
      http.username ||
      http.password ||
      websocket.username ||
      websocket.password ||
      http.search ||
      http.hash ||
      websocket.search ||
      websocket.hash ||
      !["", "/"].includes(http.pathname) ||
      !["", "/"].includes(websocket.pathname)
    )
      throw refused();
  }
  const loopbacks = input.endpoints.filter((value) => value.reachability === "loopback");
  if (
    loopbacks.length !== 1 ||
    new URL(loopbacks[0]!.httpBaseUrl).origin !== endpoint.origin ||
    loopbacks[0]!.status !== "available"
  )
    throw refused();
  const privateEndpoints = input.endpoints.filter(
    (value) => value.source === "desktop-core" && value.reachability === "lan",
  );
  if (
    privateEndpoints.length < 1 ||
    privateEndpoints.some((value) => {
      const url = new URL(value.httpBaseUrl);
      return (
        url.protocol !== "http:" ||
        !["10.254.231.1", "10.254.231.2"].includes(url.hostname) ||
        url.port !== endpoint.port ||
        value.status !== "unavailable"
      );
    })
  )
    throw refused();
  const defaults = privateEndpoints.filter((value) => value.isDefault === true);
  if (
    (route === "absent" && defaults.length !== 0) ||
    (route === "owned" &&
      (defaults.length !== 1 || new URL(defaults[0]!.httpBaseUrl).hostname !== "10.254.231.1"))
  )
    throw refused();
  if (
    input.endpoints.some(
      (value) => value.reachability !== "loopback" && value.reachability !== "lan",
    )
  )
    throw refused();
  return Object.freeze({
    nativeHost: true,
    sameBoot: true,
    sameStorage: true,
    sameVersion: true,
    ownedEndpoint: true,
    localOnlyExposure: true,
    routeMatched: true,
  });
}

/** Read only the actual native bridge; bootstrap credentials are never returned. */
export async function readNativeSharingBridge() {
  const bridge = (
    window as Window & {
      desktopBridge?: {
        getHostMetadata?: () => Promise<DesktopBridgeHostMetadata>;
        getServerExposureState: () => Promise<DesktopServerExposureState>;
        getAdvertisedEndpoints: () => Promise<readonly AdvertisedEndpoint[]>;
        getLocalEnvironmentBootstraps: () => readonly {
          id: string;
          httpBaseUrl: string | null;
          wsBaseUrl: string | null;
        }[];
      };
    }
  ).desktopBridge;
  if (
    !bridge ||
    typeof bridge.getHostMetadata !== "function" ||
    typeof bridge.getServerExposureState !== "function" ||
    typeof bridge.getAdvertisedEndpoints !== "function" ||
    typeof bridge.getLocalEnvironmentBootstraps !== "function"
  )
    throw new Error("Owned native sharing bridge unavailable.");
  const [metadata, exposure, endpoints] = await Promise.all([
    bridge.getHostMetadata(),
    bridge.getServerExposureState(),
    bridge.getAdvertisedEndpoints(),
  ]);
  const bootstraps = bridge.getLocalEnvironmentBootstraps();
  const primary = bootstraps.filter((value) => value.id === "primary");
  if (bootstraps.length !== 1 || primary.length !== 1 || primary[0]!.httpBaseUrl === null)
    throw new Error("Owned native sharing bootstrap refused.");
  return {
    metadata,
    exposure,
    endpoints,
    endpoint: primary[0]!.httpBaseUrl,
    websocket: primary[0]!.wsBaseUrl,
  };
}
const contractsSchema = NodeModule.createRequire(
  new NodeURL.URL("../../../../packages/contracts/package.json", import.meta.url),
)("effect/Schema");
/** The caller owns endpoint, descriptor transport and process lifetime; values remain private. */
export async function collectNativeSharingIdentity(input: {
  browser: QualificationBrowser;
  endpoint: string;
  descriptor: () => Promise<unknown>;
}): Promise<NativeSharingIdentityInput> {
  const raw = await input.browser.execute(readNativeSharingBridge);
  const metadata: DesktopBridgeHostMetadata = contractsSchema.decodeUnknownSync(
    DesktopBridgeHostMetadataSchema,
  )(raw.metadata);
  const exposure: DesktopServerExposureState = contractsSchema.decodeUnknownSync(
    DesktopServerExposureStateSchema,
  )(raw.exposure);
  const endpoints: readonly AdvertisedEndpoint[] = contractsSchema.decodeUnknownSync(
    contractsSchema.Array(AdvertisedEndpointSchema),
  )(raw.endpoints);
  const descriptor: ExecutionEnvironmentDescriptor = contractsSchema.decodeUnknownSync(
    DescriptorSchema,
  )(await input.descriptor());
  if (raw.endpoint !== input.endpoint || raw.websocket !== input.endpoint.replace("http:", "ws:"))
    throw new Error("Owned native sharing endpoint refused.");
  return { metadata, exposure, endpoints, descriptor, endpoint: raw.endpoint };
}
