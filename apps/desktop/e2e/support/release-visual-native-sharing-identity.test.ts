// @effect-diagnostics nodeBuiltinImport:off - Resolve only the owning contracts Schema runtime for genuine fixture decoding.
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import { expect, it, vi } from "vite-plus/test";
import {
  DesktopBridgeHostMetadataSchema,
  DesktopServerExposureStateSchema,
} from "../../../../packages/contracts/src/ipc.ts";
import { AdvertisedEndpoint } from "../../../../packages/contracts/src/remoteAccess.ts";
import { ExecutionEnvironmentDescriptor } from "../../../../packages/contracts/src/environment.ts";
import {
  collectNativeSharingIdentity,
  readNativeSharingBridge,
  validateNativeSharingIdentity,
} from "./release-visual-native-sharing-identity.ts";
const Schema = NodeModule.createRequire(
  new NodeURL.URL("../../../../packages/contracts/package.json", import.meta.url),
)("effect/Schema");
const metadata = Schema.decodeUnknownSync(DesktopBridgeHostMetadataSchema)({
  host: "tauri",
  bridgeVersion: 3,
  features: {
    localBackend: true,
    localBearerToken: true,
    clientSettings: true,
    serverExposure: true,
    wslDiscovery: true,
    sshRemoteHttp: true,
    connectionCatalog: true,
    protectedConnectionCatalog: false,
    sshProvisioning: true,
    preview: true,
    updater: false,
    menuEvents: true,
  },
});
const exposure = Schema.decodeUnknownSync(DesktopServerExposureStateSchema)({
  mode: "local-only",
  configuredMode: "local-only",
  management: "native",
  endpointUrl: null,
  advertisedHost: null,
  tailscaleServeEnabled: false,
  tailscaleServePort: 443,
});
const endpoint = Schema.decodeUnknownSync(AdvertisedEndpoint)({
  id: "owned-lan",
  label: "Local network",
  provider: { id: "desktop-core", label: "Desktop", kind: "core", isAddon: false },
  httpBaseUrl: "http://10.254.231.1:3773",
  wsBaseUrl: "ws://10.254.231.1:3773",
  reachability: "lan",
  compatibility: { hostedHttpsApp: "mixed-content-blocked", desktopApp: "compatible" },
  source: "desktop-core",
  status: "unavailable",
  isDefault: false,
});
const descriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor)({
  environmentId: "primary",
  label: "Owned",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.7.4",
  bootId: "owned-boot",
  storageInstanceId: "owned-storage",
  capabilities: {},
});
const loopback = Schema.decodeUnknownSync(AdvertisedEndpoint)({
  ...endpoint,
  id: "desktop-loopback:3773",
  httpBaseUrl: "http://127.0.0.1:3773/",
  wsBaseUrl: "ws://127.0.0.1:3773/",
  reachability: "loopback",
  status: "available",
  isDefault: false,
});
const pinned = {
  bootId: "owned-boot",
  storageInstanceId: "owned-storage",
  serverVersion: "0.7.4",
  endpoint: "http://127.0.0.1:3773",
};
it.each(["absent", "owned"] as const)(
  "binds actual typed native identity and route presentation: %s",
  (state) => {
    const value = validateNativeSharingIdentity(
      {
        metadata,
        exposure,
        endpoints: [loopback, { ...endpoint, isDefault: state === "owned" }],
        descriptor,
        endpoint: pinned.endpoint,
      },
      pinned,
      state,
    );
    expect(Object.values(value).every((flag) => flag === true)).toBe(true);
    expect(JSON.stringify(value)).not.toMatch(/owned-|http|0.7.4/);
  },
);
it.each(["boot", "storage", "version", "endpoint", "management", "wide", "default", "feature"])(
  "refuses mismatched native identity %s",
  (mode) => {
    const input = {
      metadata:
        mode === "feature"
          ? { ...metadata, features: { ...metadata.features, serverExposure: false } }
          : metadata,
      exposure:
        mode === "management"
          ? { ...exposure, management: "external" }
          : mode === "wide"
            ? { ...exposure, mode: "network-accessible" }
            : exposure,
      endpoints: [loopback, { ...endpoint, isDefault: mode === "default" }],
      descriptor: {
        ...descriptor,
        bootId: mode === "boot" ? "other" : descriptor.bootId,
        storageInstanceId: mode === "storage" ? "other" : descriptor.storageInstanceId,
        serverVersion: mode === "version" ? "0.0.0" : descriptor.serverVersion,
      },
      endpoint: mode === "endpoint" ? "http://foreign.invalid" : pinned.endpoint,
    };
    expect(() => validateNativeSharingIdentity(input as never, pinned, "absent")).toThrow();
  },
);

it.each([
  "missing-loopback",
  "foreign-loopback",
  "foreign-provider",
  "foreign-websocket",
  "duplicate",
])("rejects non-owned advertised endpoint %s", (mode) => {
  const own = { ...endpoint, isDefault: true };
  const endpoints =
    mode === "missing-loopback"
      ? [own]
      : mode === "foreign-loopback"
        ? [{ ...loopback, httpBaseUrl: "http://127.0.0.1:4999/" }, own]
        : mode === "foreign-provider"
          ? [loopback, { ...own, provider: { ...own.provider, id: "foreign" } }]
          : mode === "foreign-websocket"
            ? [loopback, { ...own, wsBaseUrl: "ws://foreign.invalid" }]
            : [loopback, own, { ...own }];
  expect(() =>
    validateNativeSharingIdentity(
      { metadata, exposure, endpoints, descriptor, endpoint: pinned.endpoint },
      pinned,
      "owned",
    ),
  ).toThrow();
});

it("decodes current bridge/descriptor contracts and binds the exact owned loopback endpoint", async () => {
  const value = await collectNativeSharingIdentity({
    browser: {
      execute: async () => ({
        metadata,
        exposure,
        endpoints: [loopback, { ...endpoint, isDefault: true }],
        endpoint: pinned.endpoint,
        websocket: "ws://127.0.0.1:3773",
      }),
    } as never,
    endpoint: pinned.endpoint,
    descriptor: async () => descriptor,
  });
  expect(validateNativeSharingIdentity(value, pinned, "owned")).toEqual(
    expect.objectContaining({ sameBoot: true, routeMatched: true }),
  );
});
it.each(["endpoint", "websocket", "descriptor", "bridge"])(
  "refuses a foreign or malformed collected native identity: %s",
  async (mode) => {
    await expect(
      collectNativeSharingIdentity({
        browser: {
          execute: async () => ({
            metadata: mode === "bridge" ? {} : metadata,
            exposure,
            endpoints: [loopback, endpoint],
            endpoint: mode === "endpoint" ? "http://127.0.0.1:4999" : pinned.endpoint,
            websocket: mode === "websocket" ? "ws://foreign.invalid" : "ws://127.0.0.1:3773",
          }),
        } as never,
        endpoint: pinned.endpoint,
        descriptor: async () => (mode === "descriptor" ? {} : descriptor),
      }),
    ).rejects.toThrow();
  },
);

it("executes the actual readonly native bridge collector without returning bootstrap credentials", async () => {
  vi.stubGlobal("window", {
    desktopBridge: {
      getHostMetadata: async () => metadata,
      getServerExposureState: async () => exposure,
      getAdvertisedEndpoints: async () => [loopback, endpoint],
      getLocalEnvironmentBootstraps: () => [
        {
          id: "primary",
          httpBaseUrl: pinned.endpoint,
          wsBaseUrl: "ws://127.0.0.1:3773",
          bootstrapToken: "private-secret-fixture",
        },
      ],
    },
  });
  try {
    const value = await readNativeSharingBridge();
    expect(value.endpoint).toBe(pinned.endpoint);
    expect(JSON.stringify(value)).not.toContain("private-secret-fixture");
    expect(Object.keys(value).sort()).toEqual([
      "endpoint",
      "endpoints",
      "exposure",
      "metadata",
      "websocket",
    ]);
  } finally {
    vi.unstubAllGlobals();
  }
});
