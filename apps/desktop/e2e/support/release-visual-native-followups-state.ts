import type { NativeFollowupScene } from "./release-visual-native-followups.ts";
import { admitNativeFollowupEndpoint } from "./release-visual-native-followups-endpoint.ts";
import type {
  DesktopBridge,
  DesktopBridgeHostMetadata,
  DesktopEnvironmentBootstrap,
  DesktopProjectDataEnvironmentStatus,
  DesktopUpdateState,
  DesktopWslState,
} from "../../../../packages/contracts/src/ipc.ts";
export type NativeFollowupWindow = Window & { readonly desktopBridge?: DesktopBridge };

export interface NativeFollowupIdentityPin {
  readonly platform: "linux" | "darwin" | "win32";
  readonly endpoint: string;
  readonly bootId: string;
  readonly storageInstanceId: string;
  readonly version: string;
  readonly effectiveRoot: string;
  readonly requestedRoot: string;
  readonly updateVersion: string;
  readonly port: number;
  readonly runningDistro: string | null;
  readonly wslHosts?: readonly string[];
}
export interface NativeFollowupState {
  readonly metadata: DesktopBridgeHostMetadata;
  readonly bootstraps: readonly Pick<
    DesktopEnvironmentBootstrap,
    "id" | "httpBaseUrl" | "wsBaseUrl" | "runningDistro"
  >[];
  readonly data: readonly Pick<
    DesktopProjectDataEnvironmentStatus,
    | "environmentId"
    | "requestedRoot"
    | "effectiveRoot"
    | "storageInstanceId"
    | "runningDistro"
    | "backups"
  >[];
  readonly update: Pick<
    DesktopUpdateState,
    | "enabled"
    | "status"
    | "phase"
    | "currentVersion"
    | "availableVersion"
    | "downloadedVersion"
    | "errorContext"
    | "backendRecovery"
    | "protection"
  >;
  readonly descriptor: {
    environmentId: string;
    platform: { os: string };
    bootId: string | null;
    storageInstanceId: string | null;
    serverVersion: string;
  } | null;
  readonly wsl: DesktopWslState | null;
}
/** Private identity inputs never enter an upload receipt. Values come from native reads. */
export function validateNativeFollowupState(
  scene: NativeFollowupScene,
  input: unknown,
  pin: NativeFollowupIdentityPin,
): Record<string, true> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Native follow-up state refused.");
  const value = input as NativeFollowupState;
  const refuse = () => {
    throw new Error("Native follow-up state refused.");
  };
  const endpoint = admitNativeFollowupEndpoint(
      pin.endpoint,
      pin.platform,
      pin.runningDistro,
      pin.wslHosts ?? [],
    ),
    data = value.data.filter((entry) => entry.environmentId === "primary"),
    boots = value.bootstraps.filter((entry) => entry.id === "primary"),
    recovery = scene === "native-update-recovery";
  if (
    !pin.bootId ||
    !pin.storageInstanceId ||
    !pin.version ||
    !pin.effectiveRoot ||
    !pin.requestedRoot ||
    !["linux", "darwin", "win32"].includes(pin.platform) ||
    endpoint.protocol !== "http:" ||
    Number(endpoint.port) !== pin.port ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !["", "/"].includes(endpoint.pathname)
  )
    refuse();
  if (
    value.metadata.host !== "tauri" ||
    value.metadata.bridgeVersion !== 3 ||
    !value.metadata.features.localBackend ||
    !value.metadata.features.clientSettings ||
    data.length !== 1 ||
    data[0]!.storageInstanceId !== pin.storageInstanceId ||
    data[0]!.requestedRoot !== pin.requestedRoot ||
    data[0]!.effectiveRoot !== pin.effectiveRoot ||
    data[0]!.runningDistro !== pin.runningDistro ||
    value.update.currentVersion !== pin.version
  )
    refuse();
  const descriptorOs = pin.runningDistro
    ? "linux"
    : pin.platform === "win32"
      ? "windows"
      : pin.platform === "darwin"
        ? "macos"
        : "linux";
  if (
    !recovery &&
    (boots.length !== 1 ||
      boots[0]!.httpBaseUrl !== pin.endpoint ||
      boots[0]!.wsBaseUrl !== pin.endpoint.replace("http:", "ws:") ||
      (boots[0]!.runningDistro ?? null) !== pin.runningDistro ||
      value.descriptor?.environmentId !== "primary" ||
      value.descriptor.platform.os !== descriptorOs ||
      value.descriptor.bootId !== pin.bootId ||
      value.descriptor.storageInstanceId !== pin.storageInstanceId ||
      value.descriptor.serverVersion !== pin.version)
  )
    refuse();
  const common = {
    nativeHost: true as const,
    storeMatched: true as const,
    versionMatched: true as const,
  };
  if (scene === "native-update-protection" || recovery) {
    const update = value.update,
      entries = update.backendRecovery ?? [];
    if (
      !value.metadata.features.updater ||
      !update.enabled ||
      update.status !== (recovery ? "error" : "downloaded") ||
      update.availableVersion !== pin.updateVersion ||
      update.downloadedVersion !== pin.updateVersion ||
      pin.updateVersion === pin.version
    )
      refuse();
    if (recovery) {
      if (
        boots.length !== 0 ||
        value.descriptor !== null ||
        update.phase !== "failed" ||
        update.errorContext !== "install" ||
        entries.length !== 1 ||
        entries[0]!.environmentId !== "primary" ||
        entries[0]!.reason !== "port-in-use" ||
        entries[0]!.port !== pin.port ||
        !update.protection?.some(
          (entry) => entry.environmentId === "primary" && entry.status === "protected",
        )
      )
        refuse();
      return Object.freeze({
        ...common,
        downloadRetained: true,
        backendStopped: true,
        portHoldMatched: true,
      });
    }
    if (entries.length || !["idle", "available"].includes(update.phase ?? "idle")) refuse();
    return Object.freeze({ ...common, downloadRetained: true });
  }
  if (scene === "native-wsl-local") {
    const wsl = value.wsl,
      distro = pin.runningDistro;
    if (
      pin.platform !== "win32" ||
      !value.metadata.features.wslDiscovery ||
      !wsl?.available ||
      !wsl.enabled ||
      wsl.preflightError !== null ||
      !distro ||
      !wsl.distros.some((entry) => entry.name === distro) ||
      (wsl.distro !== null && wsl.distro !== distro)
    )
      refuse();
    return Object.freeze({
      ...common,
      nativeWindows: true,
      wslAvailable: true,
      mappedDistro: true,
      topologyMatched: true,
    });
  }
  if (
    scene === "native-menu-theme" &&
    (pin.platform === "win32" || !value.metadata.features.menuEvents)
  )
    refuse();
  if (scene === "native-preview-annotations" && !value.metadata.features.preview) refuse();
  return Object.freeze(common);
}

/** Only real DesktopBridge getters are used; bootstrap credentials never leave this callback. */
export async function readNativeFollowupBridge() {
  const bridge = (window as NativeFollowupWindow).desktopBridge;
  if (
    !bridge ||
    typeof bridge.getHostMetadata !== "function" ||
    typeof bridge.getProjectDataStatuses !== "function"
  )
    throw new Error("Native follow-up bridge unavailable.");
  const [metadata, data, update, wsl] = await Promise.all([
    bridge.getHostMetadata(),
    bridge.getProjectDataStatuses(),
    bridge.getUpdateState(),
    bridge.getWslState(),
  ]);
  return {
    metadata,
    data,
    update,
    wsl,
    bootstraps: bridge.getLocalEnvironmentBootstraps().map((entry) => ({
      id: entry.id,
      httpBaseUrl: entry.httpBaseUrl,
      wsBaseUrl: entry.wsBaseUrl,
      runningDistro: entry.runningDistro ?? null,
    })),
  };
}
