import { expect, it } from "vite-plus/test";
import { validateNativeFollowupState } from "./release-visual-native-followups-state.ts";

const pin = {
  platform: "linux" as const,
  endpoint: "http://127.0.0.1:4800",
  bootId: "boot-owned",
  storageInstanceId: "store-owned",
  version: "0.8.0",
  effectiveRoot: "/owned/data/userdata",
  requestedRoot: "/owned/data/userdata",
  updateVersion: "0.8.1-upgrade.1",
  port: 4800,
  runningDistro: null,
};
const metadata = {
  host: "tauri",
  bridgeVersion: 3,
  features: {
    localBackend: true,
    localBearerToken: true,
    clientSettings: true,
    serverExposure: true,
    wslDiscovery: false,
    sshRemoteHttp: true,
    connectionCatalog: true,
    protectedConnectionCatalog: false,
    sshProvisioning: true,
    preview: true,
    updater: true,
    menuEvents: true,
  },
};
const descriptor = {
  bootId: "boot-owned",
  storageInstanceId: "store-owned",
  serverVersion: "0.8.0",
  platform: { os: "linux" },
  environmentId: "primary",
};
const data = [
  {
    environmentId: "primary",
    label: "Owned local",
    requestedRoot: pin.requestedRoot,
    effectiveRoot: pin.effectiveRoot,
    storageInstanceId: pin.storageInstanceId,
    runningDistro: null,
    status: "healthy",
    backups: [],
  },
];
const update = {
  enabled: true,
  status: "downloaded",
  phase: "idle",
  currentVersion: "0.8.0",
  availableVersion: pin.updateVersion,
  downloadedVersion: pin.updateVersion,
  errorContext: null,
  backendRecovery: [],
  protection: [],
};
const state = () => ({
  metadata,
  bootstraps: [
    {
      id: "primary",
      httpBaseUrl: pin.endpoint,
      wsBaseUrl: pin.endpoint.replace("http:", "ws:"),
      backendKind: "native",
      preflightError: null,
    },
  ],
  descriptor,
  data,
  update,
  wsl: null,
});

it("admits the current actual native updater and rejects version, boot, storage, root and capability drift", () => {
  expect(validateNativeFollowupState("native-update-protection", state(), pin)).toMatchObject({
    nativeHost: true,
    storeMatched: true,
    versionMatched: true,
    downloadRetained: true,
  });
  for (const input of [
    { ...state(), descriptor: { ...descriptor, bootId: "other" } },
    { ...state(), data: [{ ...data[0]!, effectiveRoot: "/other/userdata" }] },
    { ...state(), update: { ...update, downloadedVersion: "9.9.9" } },
    { ...state(), metadata: { ...metadata, features: { ...metadata.features, updater: false } } },
    { ...state(), descriptor: { ...descriptor, platform: { os: "windows" } } },
  ])
    expect(() => validateNativeFollowupState("native-update-protection", input, pin)).toThrow();
});

it("requires the withheld original bootstrap and retained download for port-held recovery", () => {
  const recovery = {
    ...state(),
    descriptor: null,
    bootstraps: [],
    update: {
      ...update,
      status: "error",
      phase: "failed",
      errorContext: "install",
      backendRecovery: [
        { environmentId: "primary", label: "Owned local", reason: "port-in-use", port: 4800 },
      ],
      protection: [
        { environmentId: "primary", label: "Owned local", status: "protected", message: null },
      ],
    },
  };
  expect(validateNativeFollowupState("native-update-recovery", recovery, pin)).toMatchObject({
    backendStopped: true,
    downloadRetained: true,
    portHoldMatched: true,
  });
  expect(() =>
    validateNativeFollowupState(
      "native-update-recovery",
      { ...recovery, bootstraps: state().bootstraps },
      pin,
    ),
  ).toThrow();
  expect(() =>
    validateNativeFollowupState(
      "native-update-recovery",
      {
        ...recovery,
        update: {
          ...recovery.update,
          backendRecovery: [{ ...recovery.update.backendRecovery[0]!, port: 4801 }],
        },
      },
      pin,
    ),
  ).toThrow();
});

it("never accepts Linux metadata or an unavailable mapped WSL capability as a Windows row", () => {
  expect(() => validateNativeFollowupState("native-wsl-local", state(), pin)).toThrow();
  const windowsPin = { ...pin, platform: "win32" as const, runningDistro: "OwnedDistro" };
  const windows = {
    ...state(),
    metadata: { ...metadata, features: { ...metadata.features, wslDiscovery: true } },
    descriptor: { ...descriptor, platform: { os: "windows" } },
    wsl: {
      available: false,
      enabled: true,
      wslOnly: false,
      distro: "OwnedDistro",
      distros: [{ name: "OwnedDistro", isDefault: true, state: "Running" }],
      preflightError: null,
    },
  };
  expect(() => validateNativeFollowupState("native-wsl-local", windows, windowsPin)).toThrow();
});
