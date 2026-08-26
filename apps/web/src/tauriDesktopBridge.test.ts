import {
  BearerConnectionTarget,
  ConnectionTransientError,
  decideStorageIdentity,
  type PreparedConnection,
  verifyPreparedStorageIdentity,
} from "@bibcode/client-runtime/connection";
import { AcceptedStorageIdentityStore } from "@bibcode/client-runtime/platform";
import { DEFAULT_CLIENT_SETTINGS, type DesktopBridge, EnvironmentId } from "@bibcode/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { connectionStorageLayer } from "./connection/storage";

type TauriEventHandler = (event: { payload: unknown }) => void;

const { showContextMenuFallbackMock, startBrowserSurfaceSyncMock } = vi.hoisted(() => ({
  showContextMenuFallbackMock: vi.fn(),
  startBrowserSurfaceSyncMock: vi.fn(),
}));

vi.mock("./browser/browserSurfaceSync", () => ({
  startBrowserSurfaceSync: startBrowserSurfaceSyncMock,
}));

vi.mock("./contextMenuFallback", () => ({
  showContextMenuFallback: showContextMenuFallbackMock,
}));

const unsupportedSshError = {
  code: "tauri_capability_unsupported",
  method: "ensureSshEnvironment",
  capability: "sshProvisioning",
  message: "ensureSshEnvironment requires sshProvisioning, which is temporarily unavailable.",
};

const unsupportedContextMenuError = {
  code: "tauri_capability_unsupported",
  method: "showContextMenu",
  capability: "nativeContextMenu",
  message: "showContextMenu requires nativeContextMenu, which is temporarily unavailable.",
};

const defaultLocalEnvironmentBootstrap = {
  id: "primary",
  label: "Local",
  httpBaseUrl: "http://127.0.0.1:3773",
  wsBaseUrl: "ws://127.0.0.1:3773",
  bootstrapToken: "bootstrap-token",
};

const defaultSshDescriptor = {
  environmentId: "00000000-0000-4000-8000-000000000071",
  label: "SSH environment",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.4.2",
  storageInstanceId: "00000000-0000-4000-8000-000000000072",
  protocol: { minimum: 1, maximum: 1 },
  capabilities: {
    repositoryIdentity: true,
    worktreeCatalog: false,
    worktreeCatalogRefreshReason: false,
    vcsStatusSummary: false,
    activityProtocolVersion: null,
  },
  transport: { mode: "loopback-http" },
} as const;

const defaultWslDiscovery = {
  generation: 7,
  observedAt: "2026-08-25T00:00:00Z",
  health: "available",
  detail: null,
  distros: [{ name: "Ubuntu", isDefault: true, state: "running", version: 2 }],
} as const;

const defaultWslState = {
  enabled: true,
  distro: null,
  legacyAcceptedDistro: null,
  available: true,
  wslOnly: false,
  distros: defaultWslDiscovery.distros,
  discovery: defaultWslDiscovery,
  preflightError: null,
} as const;

function installTauriHarness(options?: {
  readonly previewSupported?: boolean;
  readonly protectedConnectionCatalog?: boolean;
  readonly rejectMetadata?: boolean;
  readonly metadataError?: unknown;
  readonly bridgeVersion?: number;
  readonly omitProtectedConnectionCatalog?: boolean;
  readonly contextMenuResult?: string | null;
  readonly rejectContextMenu?: unknown;
  readonly rejectSshProvisioning?: boolean;
  readonly localEnvironmentBootstraps?: readonly unknown[] | (() => readonly unknown[]);
  readonly nativeConnectionCatalog?: string | null | (() => string | null);
  readonly compareAndSetConnectionCatalog?: (
    expectedCatalog: string | null,
    nextCatalog: string,
  ) => boolean;
  readonly compareConnectionCatalog?: (expectedCatalog: string | null) => boolean;
  readonly rejectConnectionCatalogCompareAndSet?: unknown;
  readonly rejectSecretStore?: unknown;
  readonly clearConnectionCatalog?: () => void;
  readonly rejectFallbackCommands?: boolean;
  readonly rejectListeners?: boolean;
  readonly sshDescriptor?: unknown;
}) {
  const listeners = new Map<string, TauriEventHandler>();
  const unlisteners = new Map<string, ReturnType<typeof vi.fn>>();

  const invoke = vi.fn((command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case "desktop_bridge_get_bridge_metadata":
        if (options?.rejectMetadata) {
          return Promise.reject(options.metadataError ?? new Error("bridge metadata unavailable"));
        }
        return Promise.resolve({
          host: "tauri",
          bridgeVersion: options?.bridgeVersion ?? 3,
          features: {
            localBackend: true,
            localBearerToken: true,
            clientSettings: true,
            serverExposure: true,
            wslDiscovery: true,
            sshRemoteHttp: true,
            connectionCatalog: true,
            ...(options?.omitProtectedConnectionCatalog
              ? {}
              : {
                  protectedConnectionCatalog: options?.protectedConnectionCatalog ?? true,
                }),
            preview: options?.previewSupported ?? false,
            updater: false,
            menuEvents: true,
            sshProvisioning: true,
            environmentRemoval: true,
          },
        });
      case "desktop_bridge_check_for_update":
        return Promise.resolve({
          checked: false,
          state: { status: "disabled" },
        });
      case "desktop_bridge_download_update":
        return Promise.resolve({
          accepted: false,
          completed: false,
          state: { status: "disabled" },
        });
      case "desktop_bridge_install_update":
        return Promise.resolve({
          accepted: false,
          completed: false,
          state: { status: "disabled" },
        });
      case "desktop_bridge_put_secret":
        if (options?.rejectSecretStore !== undefined) {
          return Promise.reject(options.rejectSecretStore);
        }
        return Promise.resolve("bibcode-secret:70a3dd71-952a-4eb6-a9a8-424a462e33c8");
      case "desktop_bridge_get_secret":
        if (options?.rejectSecretStore !== undefined) {
          return Promise.reject(options.rejectSecretStore);
        }
        return Promise.resolve(
          args?.secretRef === "bibcode-secret:70a3dd71-952a-4eb6-a9a8-424a462e33c8"
            ? "secret-value"
            : null,
        );
      case "desktop_bridge_delete_secret":
        if (options?.rejectSecretStore !== undefined) {
          return Promise.reject(options.rejectSecretStore);
        }
        return Promise.resolve(undefined);
      case "desktop_bridge_save_diagnostic_logs":
        return Promise.resolve("C:\\Users\\test\\Downloads\\diagnostics.zip");
      case "desktop_bridge_ensure_ssh_environment":
        if (options?.rejectSshProvisioning) {
          return Promise.reject(unsupportedSshError);
        }
        return Promise.resolve({
          target: args?.target,
          httpBaseUrl: "http://127.0.0.1:3773/",
          wsBaseUrl: "ws://127.0.0.1:3773/",
          hostKeyFingerprint: "SHA256:known-host-key",
          remotePort: 3773,
          remoteServerKind: "managed",
        });
      case "desktop_bridge_prepare_ssh_server":
        return Promise.resolve({
          requestId: "ssh-setup-1",
          probeGeneration: 8,
          target: (args?.input as { readonly target?: unknown } | undefined)?.target,
          hostKeyFingerprint: "SHA256:known-host-key",
          compatibility: "compatible",
          probe: {
            os: "linux",
            architecture: "x86_64",
            installedVersion: "0.4.2",
            serviceMode: "workstation",
            serviceState: "running",
            dataRoot: "/home/dev/.bibcode",
            controlAvailable: true,
            freeBytes: 1_000_000,
            installAuthority: "user",
          },
          installedBinaryPath: "/usr/bin/bibcode",
          consent: null,
          detail: null,
        });
      case "desktop_bridge_install_ssh_server":
        return Promise.resolve({
          requestId: "ssh-setup-1",
          generation: 8,
          target: {
            alias: "host-1",
            hostname: "example.test",
            username: null,
            port: null,
          },
          status: "cancelled",
          stage: "probe",
          mutationStatus: "none",
          cleanupStatus: "notRequired",
          installedVersion: null,
          previousVersion: "0.4.1",
          managedBinaryPath: null,
          dataRoot: "/home/dev/.bibcode",
          hostKeyFingerprint: "SHA256:known-host-key",
          descriptor: null,
          bootstrap: null,
          recoveryCommand: null,
          message: "SSH server installation was declined before mutation.",
        });
      case "desktop_bridge_prepare_wsl_server":
        return Promise.resolve({
          requestId: "wsl-setup-1",
          probeGeneration: 7,
          discoveryGeneration: 7,
          distro: "Ubuntu",
          compatibility: "compatible",
          probe: {
            os: "linux",
            architecture: "x86_64",
            installedVersion: "0.4.2",
            serviceMode: "workstation",
            serviceState: "running",
            dataRoot: "/home/dev/.bibcode",
            controlAvailable: true,
            freeBytes: 1_000_000,
            installAuthority: "user",
          },
          installedBinaryPath: "/usr/bin/bibcode",
          consent: null,
          detail: null,
        });
      case "desktop_bridge_install_wsl_server":
        return Promise.resolve({
          requestId: "wsl-setup-1",
          generation: 7,
          distro: "Ubuntu",
          status: "cancelled",
          stage: "probe",
          mutationStatus: "none",
          cleanupStatus: "notRequired",
          installedVersion: null,
          previousVersion: "0.4.1",
          managedBinaryPath: null,
          dataRoot: "/home/dev/.bibcode",
          descriptor: null,
          message: "WSL server installation was declined before mutation.",
        });
      case "desktop_bridge_cancel_wsl_setup":
        return Promise.resolve(true);
      case "desktop_bridge_plan_environment_removal":
        return Promise.resolve({
          schemaVersion: 1,
          planId: "6eef32c8-3c6d-4c0d-ad5c-2e9f6dd54074",
          target: { transport: "wsl", distro: "Ubuntu", discoveryGeneration: 7 },
          environmentId: "76aa78e8-67aa-477e-bd25-68f491885224",
          storageId: "3039b232-95d0-4b2f-a35e-c297b4c895af",
          environmentName: "Build host",
          dataRoot: "/home/dev/.bibcode",
          projectCount: 0,
          worktreeCount: 0,
          processCount: 0,
          otherPairedClientCount: 1,
          createdAt: "2036-08-25T12:00:00.000Z",
          expiresAt: "2036-08-25T12:05:00.000Z",
          uninstallSupported: true,
          uninstallUnavailableReason: null,
        });
      case "desktop_bridge_execute_environment_removal":
        return Promise.resolve({
          action: "uninstall",
          environmentId: "76aa78e8-67aa-477e-bd25-68f491885224",
          storageId: "3039b232-95d0-4b2f-a35e-c297b4c895af",
          serviceRemoved: true,
          binaryRemoved: true,
          dataRemoved: false,
          dataRootPreserved: true,
          verified: true,
        });
      case "desktop_bridge_get_wsl_state":
      case "desktop_bridge_refresh_wsl_discovery":
        return options?.rejectFallbackCommands
          ? Promise.reject(new Error(`unsupported fallback command: ${command}`))
          : Promise.resolve(defaultWslState);
      case "desktop_bridge_show_context_menu":
        if ("rejectContextMenu" in (options ?? {})) {
          return Promise.reject(options?.rejectContextMenu);
        }
        return Promise.resolve(options?.contextMenuResult ?? null);
      case "desktop_bridge_get_local_environment_bootstraps":
        return Promise.resolve(
          typeof options?.localEnvironmentBootstraps === "function"
            ? options.localEnvironmentBootstraps()
            : (options?.localEnvironmentBootstraps ?? [defaultLocalEnvironmentBootstrap]),
        );
      case "desktop_bridge_get_connection_catalog":
        return options?.rejectFallbackCommands
          ? Promise.reject(new Error("native catalog unavailable"))
          : Promise.resolve(
              options !== undefined && "nativeConnectionCatalog" in options
                ? typeof options.nativeConnectionCatalog === "function"
                  ? options.nativeConnectionCatalog()
                  : options.nativeConnectionCatalog
                : "native-catalog",
            );
      case "desktop_bridge_set_connection_catalog":
        return options?.rejectFallbackCommands
          ? Promise.reject(new Error("native catalog unavailable"))
          : Promise.resolve(args?.catalog === "saved-catalog");
      case "desktop_bridge_compare_and_set_connection_catalog":
        if ("rejectConnectionCatalogCompareAndSet" in (options ?? {})) {
          return Promise.reject(options?.rejectConnectionCatalogCompareAndSet);
        }
        return options?.rejectFallbackCommands
          ? Promise.reject(new Error("native catalog unavailable"))
          : Promise.resolve(
              options?.compareAndSetConnectionCatalog?.(
                (args?.expectedCatalog as string | null) ?? null,
                args?.nextCatalog as string,
              ) ??
                (args?.expectedCatalog === "native-catalog" &&
                  args?.nextCatalog === "saved-catalog"),
            );
      case "desktop_bridge_compare_connection_catalog":
        return options?.rejectFallbackCommands
          ? Promise.reject(new Error("native catalog unavailable"))
          : Promise.resolve(
              options?.compareConnectionCatalog?.(
                (args?.expectedCatalog as string | null) ?? null,
              ) ?? args?.expectedCatalog === "native-catalog",
            );
      case "desktop_bridge_clear_connection_catalog":
        if (options?.rejectFallbackCommands) {
          return Promise.reject(new Error("native catalog unavailable"));
        }
        options?.clearConnectionCatalog?.();
        return Promise.resolve(undefined);
      case "desktop_bridge_fetch_environment_descriptor":
        return Promise.resolve(options?.sshDescriptor ?? defaultSshDescriptor);
      case "desktop_bridge_pair_ssh_environment":
        return Promise.resolve({ access_token: "ssh-bearer" });
      case "desktop_bridge_fetch_ssh_session_state":
        return Promise.resolve({ authenticated: true });
      case "desktop_bridge_issue_ssh_web_socket_ticket":
        return Promise.resolve({ ticket: "ws-ticket" });
      default:
        return options?.rejectFallbackCommands
          ? Promise.reject(new Error(`unsupported fallback command: ${command}`))
          : Promise.resolve(null);
    }
  });

  const listen = vi.fn(async (event: string, handler: TauriEventHandler) => {
    if (options?.rejectListeners) {
      throw new Error(`listener unavailable: ${event}`);
    }
    listeners.set(event, handler);
    const unlisten = vi.fn(() => {
      listeners.delete(event);
    });
    unlisteners.set(event, unlisten);
    return unlisten;
  });

  vi.stubGlobal("window", {
    __TAURI__: {
      core: { invoke },
      event: { listen },
    },
    desktopBridge: undefined,
  });

  return { invoke, listen, listeners, unlisteners };
}

async function installBridge(): Promise<DesktopBridge> {
  const { tauriDesktopBridgeReady } = await import("./tauriDesktopBridge");
  await tauriDesktopBridgeReady;
  const bridge = window.desktopBridge;
  if (!bridge) {
    throw new Error("Expected Tauri adapter to install window.desktopBridge.");
  }
  return bridge;
}

const SENSITIVE_CONNECTION_CATALOG = JSON.stringify({
  schemaVersion: 1,
  targets: [
    {
      _tag: "BearerConnectionTarget",
      environmentId: "sensitive-environment",
      label: "Sensitive remote",
      connectionId: "sensitive-connection",
    },
  ],
  profiles: [
    {
      _tag: "BearerConnectionProfile",
      connectionId: "sensitive-connection",
      environmentId: "sensitive-environment",
      label: "Sensitive remote",
      httpBaseUrl: "https://private.example.test/secret-path",
      wsBaseUrl: "wss://private.example.test/secret-path",
    },
  ],
  credentials: [
    {
      connectionId: "sensitive-connection",
      credential: {
        _tag: "BearerConnectionCredential",
        token: "secret-bearer-token",
      },
    },
  ],
  remoteDpopTokens: [
    {
      environmentId: "sensitive-environment",
      label: "Sensitive remote",
      endpoint: {
        httpBaseUrl: "https://private.example.test/secret-path",
        wsBaseUrl: "wss://private.example.test/secret-path",
        providerKind: "cloudflare_tunnel",
      },
      accessToken: "secret-dpop-token",
      expiresAtEpochMs: 1_000_000,
      dpopThumbprint: "secret-thumbprint",
    },
  ],
  acceptedStorageIdentities: [
    {
      targetKey: "bearer:sensitive-connection",
      storageInstanceId: "sensitive-store-id",
    },
  ],
});

function sensitivePrepared(storageInstanceId: string): PreparedConnection {
  const environmentId = EnvironmentId.make("sensitive-environment");
  const target = new BearerConnectionTarget({
    environmentId,
    label: "Sensitive remote",
    connectionId: "sensitive-connection",
  });
  return {
    environmentId,
    label: target.label,
    descriptor: {
      environmentId,
      label: target.label,
      platform: { os: "windows", arch: "x64" },
      serverVersion: "0.0.0-test",
      storageInstanceId,
      protocol: { minimum: 1, maximum: 1 },
      capabilities: {
        repositoryIdentity: true,
        worktreeCatalog: false,
        worktreeCatalogRefreshReason: false,
        vcsStatusSummary: false,
        activityProtocolVersion: null,
      },
    },
    httpBaseUrl: "https://private.example.test/secret-path",
    socketUrl: "wss://private.example.test/secret-path/ws",
    httpAuthorization: null,
    target,
  };
}

function readIndexedDbConnectionCatalog(factory: IDBFactory): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const open = factory.open("bibcode:connection-runtime", 3);
    open.addEventListener("error", () => reject(open.error));
    open.addEventListener("success", () => {
      const database = open.result;
      const request = database
        .transaction("catalog", "readonly")
        .objectStore("catalog")
        .get("document");
      request.addEventListener("error", () => reject(request.error));
      request.addEventListener("success", () => {
        const raw = request.result;
        database.close();
        resolve(typeof raw === "string" ? raw : null);
      });
    });
  });
}

describe("tauriDesktopBridge", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    showContextMenuFallbackMock.mockReset();
    startBrowserSurfaceSyncMock.mockReset();
  });

  it("starts browser surface sync once when installing the Tauri preview bridge", async () => {
    installTauriHarness({ previewSupported: true });

    const bridge = await installBridge();
    await import("./tauriDesktopBridge");

    expect(startBrowserSurfaceSyncMock).toHaveBeenCalledTimes(1);
    expect(startBrowserSurfaceSyncMock).toHaveBeenCalledWith(bridge.preview);
  });

  it("publishes supported preview before readiness-gated consumers cache it", async () => {
    installTauriHarness({ previewSupported: true });

    const bridge = await installBridge();
    const { previewBridge } = await import("./components/preview/previewBridge");

    expect(previewBridge).toBe(bridge.preview);
  });

  it("omits the preview bridge when the native host reports it unsupported", async () => {
    installTauriHarness({ previewSupported: false });

    const bridge = await installBridge();

    expect(bridge.preview).toBeUndefined();
    expect(startBrowserSurfaceSyncMock).not.toHaveBeenCalled();
  });

  it("fails closed when native preview support cannot be determined", async () => {
    installTauriHarness({ rejectMetadata: true });

    const bridge = await installBridge();

    expect(bridge.preview).toBeUndefined();
    expect(startBrowserSurfaceSyncMock).not.toHaveBeenCalled();
  });

  it("does not start browser surface sync in a browser runtime", async () => {
    vi.stubGlobal("window", { desktopBridge: undefined });

    const { tauriDesktopBridgeReady } = await import("./tauriDesktopBridge");
    await tauriDesktopBridgeReady;

    expect(window.desktopBridge).toBeUndefined();
    expect(startBrowserSurfaceSyncMock).not.toHaveBeenCalled();
  });

  it("does not start browser surface sync when a desktop bridge already exists", async () => {
    installTauriHarness();
    const existingBridge = { preview: { setBounds: vi.fn() } } as unknown as DesktopBridge;
    window.desktopBridge = existingBridge;

    const { tauriDesktopBridgeReady } = await import("./tauriDesktopBridge");
    await tauriDesktopBridgeReady;

    expect(window.desktopBridge).toBe(existingBridge);
    expect(startBrowserSurfaceSyncMock).not.toHaveBeenCalled();
  });

  it("waits for the primary bootstrap before reporting the Tauri bridge ready", async () => {
    let reads = 0;
    const primaryBootstrap = {
      id: "primary",
      label: "Local",
      httpBaseUrl: "http://127.0.0.1:3773",
      wsBaseUrl: "ws://127.0.0.1:3773",
      bootstrapToken: "bootstrap-token",
    };
    installTauriHarness({
      localEnvironmentBootstraps: () => (++reads === 1 ? [] : [primaryBootstrap]),
    });

    const { tauriDesktopBridgeReady } = await import("./tauriDesktopBridge");
    await tauriDesktopBridgeReady;

    expect(reads).toBeGreaterThanOrEqual(2);
    expect(window.desktopBridge?.getLocalEnvironmentBootstraps()).toEqual([primaryBootstrap]);
  });

  it("routes SSH remote API helpers through Tauri commands", async () => {
    const harness = installTauriHarness();
    const bridge = await installBridge();

    await expect(bridge.fetchSshEnvironmentDescriptor("http://127.0.0.1:3773")).resolves.toEqual({
      ...defaultSshDescriptor,
    });
    const target = {
      alias: "host-1",
      hostname: "example.test",
      username: null,
      port: null,
    };
    const descriptor = {
      environmentId: EnvironmentId.make("00000000-0000-4000-8000-000000000071"),
      label: "SSH",
      platform: { os: "linux", arch: "x64" },
      serverVersion: "0.4.2",
      storageInstanceId: "00000000-0000-4000-8000-000000000072",
      protocol: { minimum: 1, maximum: 1 },
      capabilities: {
        repositoryIdentity: true,
        worktreeCatalog: false,
        worktreeCatalogRefreshReason: false,
        vcsStatusSummary: false,
        activityProtocolVersion: null,
      },
    } as const;
    await expect(bridge.pairSshEnvironment(target, descriptor)).resolves.toEqual({
      access_token: "ssh-bearer",
    });
    await expect(
      bridge.fetchSshSessionState("http://127.0.0.1:3773", "bearer-token"),
    ).resolves.toEqual({ authenticated: true });
    await expect(
      bridge.issueSshWebSocketTicket("http://127.0.0.1:3773", "bearer-token"),
    ).resolves.toEqual({ ticket: "ws-ticket" });

    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_fetch_environment_descriptor", {
      httpBaseUrl: "http://127.0.0.1:3773",
    });
    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_pair_ssh_environment", {
      target,
      descriptor,
    });
    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_fetch_ssh_session_state", {
      httpBaseUrl: "http://127.0.0.1:3773",
      bearerToken: "bearer-token",
    });
    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_issue_ssh_web_socket_ticket", {
      httpBaseUrl: "http://127.0.0.1:3773",
      bearerToken: "bearer-token",
    });
  });

  it("routes typed SSH probe and one-use setup consent through native commands", async () => {
    const harness = installTauriHarness();
    const bridge = await installBridge();
    const target = {
      alias: "host-1",
      hostname: "example.test",
      username: null,
      port: null,
    };

    await expect(
      bridge.prepareSshServer({
        target,
        expectedHostKeyFingerprint: "SHA256:known-host-key",
        managedBinaryPath: "/usr/bin/bibcode",
        serviceMode: "workstation",
      }),
    ).resolves.toMatchObject({
      compatibility: "compatible",
      probe: { os: "linux", freeBytes: 1_000_000 },
    });
    await expect(
      bridge.installSshServer({ requestId: "ssh-setup-1", probeGeneration: 8, accepted: false }),
    ).resolves.toMatchObject({ status: "cancelled", mutationStatus: "none" });

    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_prepare_ssh_server", {
      input: {
        target,
        expectedHostKeyFingerprint: "SHA256:known-host-key",
        managedBinaryPath: "/usr/bin/bibcode",
        serviceMode: "workstation",
      },
    });
    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_install_ssh_server", {
      decision: { requestId: "ssh-setup-1", probeGeneration: 8, accepted: false },
    });
  });

  it("rejects a malformed SSH descriptor at the typed desktop boundary", async () => {
    installTauriHarness({
      sshDescriptor: {
        ...defaultSshDescriptor,
        protocol: {},
      },
    });
    const bridge = await installBridge();

    await expect(bridge.fetchSshEnvironmentDescriptor("http://127.0.0.1:3773")).rejects.toThrow();
  });

  it("exposes Tauri bridge metadata and structured unsupported errors", async () => {
    const harness = installTauriHarness();
    const bridge = await installBridge();

    await expect(bridge.getHostMetadata?.()).resolves.toEqual({
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
        protectedConnectionCatalog: true,
        environmentRemoval: true,
        preview: false,
        updater: false,
        menuEvents: true,
        sshProvisioning: true,
      },
    });
    const branding = bridge.getAppBranding();
    expect(branding?.baseName).toBe("BiBCode");
    expect(["Latest", "Dev", "Nightly"]).toContain(branding?.stageLabel);
    expect(branding?.displayName).toBe(
      branding?.stageLabel === "Latest" ? "BiBCode" : `BiBCode (${branding?.stageLabel})`,
    );

    await expect(
      bridge.ensureSshEnvironment({
        alias: "host-1",
        hostname: "example.test",
        username: null,
        port: null,
      }),
    ).resolves.toEqual({
      target: {
        alias: "host-1",
        hostname: "example.test",
        username: null,
        port: null,
      },
      httpBaseUrl: "http://127.0.0.1:3773/",
      wsBaseUrl: "ws://127.0.0.1:3773/",
      hostKeyFingerprint: "SHA256:known-host-key",
      remotePort: 3773,
      remoteServerKind: "managed",
    });

    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_get_bridge_metadata", undefined);
    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_ensure_ssh_environment", {
      target: {
        alias: "host-1",
        hostname: "example.test",
        username: null,
        port: null,
      },
      options: undefined,
    });
  });

  it("routes opaque secret operations without an inventory command", async () => {
    const harness = installTauriHarness();
    const bridge = await installBridge();

    const reference = await bridge.putSecret?.({
      purpose: "environment-session",
      value: "secret-value",
    });
    expect(reference).toBe("bibcode-secret:70a3dd71-952a-4eb6-a9a8-424a462e33c8");
    await expect(bridge.getSecret?.(reference!)).resolves.toBe("secret-value");
    await expect(bridge.deleteSecret?.(reference!)).resolves.toBeUndefined();
    expect("listSecrets" in bridge).toBe(false);
    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_put_secret", {
      input: { purpose: "environment-session", value: "secret-value" },
    });
    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_get_secret", {
      secretRef: reference,
    });
    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_delete_secret", {
      secretRef: reference,
    });
  });

  it("normalizes redacted secret-provider errors into stable typed failures", async () => {
    installTauriHarness({ rejectSecretStore: { code: "locked" } });
    const bridge = await installBridge();

    await expect(
      bridge.putSecret?.({ purpose: "cache-key", value: "seeded-secret-canary" }),
    ).rejects.toMatchObject({
      name: "TauriDesktopSecretStoreError",
      code: "locked",
    });
  });

  it("routes connection catalog persistence through Tauri commands", async () => {
    const harness = installTauriHarness();
    const bridge = await installBridge();

    expect(bridge.getConnectionCatalog).toBeDefined();
    expect(bridge.setConnectionCatalog).toBeDefined();
    expect(bridge.compareAndSetConnectionCatalog).toBeDefined();
    expect(bridge.compareConnectionCatalog).toBeDefined();
    expect(bridge.clearConnectionCatalog).toBeDefined();

    await expect(bridge.getConnectionCatalog!()).resolves.toBe("native-catalog");
    await expect(bridge.setConnectionCatalog!("saved-catalog")).resolves.toBe(true);
    await expect(
      bridge.compareAndSetConnectionCatalog!("native-catalog", "saved-catalog"),
    ).resolves.toBe(true);
    await expect(bridge.compareConnectionCatalog!("native-catalog")).resolves.toBe(true);
    await expect(bridge.clearConnectionCatalog!()).resolves.toBeUndefined();

    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_get_connection_catalog", undefined);
    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_set_connection_catalog", {
      catalog: "saved-catalog",
    });
    expect(harness.invoke).toHaveBeenCalledWith(
      "desktop_bridge_compare_and_set_connection_catalog",
      {
        expectedCatalog: "native-catalog",
        nextCatalog: "saved-catalog",
      },
    );
    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_compare_connection_catalog", {
      expectedCatalog: "native-catalog",
    });
    expect(harness.invoke).toHaveBeenCalledWith(
      "desktop_bridge_clear_connection_catalog",
      undefined,
    );
  });

  it("collapses a protected legacy catalog into native storage before publishing the bridge", async () => {
    const storage = new Map<string, string>([
      ["bibcode.connectionCatalog", SENSITIVE_CONNECTION_CATALOG],
    ]);
    const localStorage = {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
      removeItem: vi.fn((key: string) => storage.delete(key)),
    };
    let nativeCatalog: string | null = null;
    const compareAndSetConnectionCatalog = vi.fn(
      (expectedCatalog: string | null, nextCatalog: string) => {
        if (nativeCatalog !== expectedCatalog) return false;
        nativeCatalog = nextCatalog;
        return true;
      },
    );
    const harness = installTauriHarness({
      nativeConnectionCatalog: () => nativeCatalog,
      compareAndSetConnectionCatalog,
      compareConnectionCatalog: (expected) => nativeCatalog === expected,
    });
    Object.assign(window, { localStorage });
    vi.stubGlobal("localStorage", localStorage);
    const bridge = await installBridge();

    expect(nativeCatalog).toBe(SENSITIVE_CONNECTION_CATALOG);
    expect(storage.has("bibcode.connectionCatalog")).toBe(false);
    await expect(bridge.getConnectionCatalog!()).resolves.toBe(SENSITIVE_CONNECTION_CATALOG);
    await expect(bridge.compareConnectionCatalog!(SENSITIVE_CONNECTION_CATALOG)).resolves.toBe(
      true,
    );
    expect(compareAndSetConnectionCatalog).toHaveBeenCalledTimes(1);
    expect(compareAndSetConnectionCatalog).toHaveBeenCalledWith(null, SENSITIVE_CONNECTION_CATALOG);
    expect(harness.invoke).toHaveBeenCalledWith(
      "desktop_bridge_compare_and_set_connection_catalog",
      { expectedCatalog: null, nextCatalog: SENSITIVE_CONNECTION_CATALOG },
    );
  });

  effectIt.effect(
    "keeps accepted changed and unverifiable decisions read-only after protected migration",
    () =>
      Effect.gen(function* () {
        vi.stubGlobal("indexedDB", new IDBFactory());
        const storage = new Map<string, string>([
          ["bibcode.connectionCatalog", SENSITIVE_CONNECTION_CATALOG],
        ]);
        const localStorage = {
          getItem: vi.fn((key: string) => storage.get(key) ?? null),
          setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
          removeItem: vi.fn((key: string) => storage.delete(key)),
        };
        let nativeCatalog: string | null = null;
        const compareAndSetConnectionCatalog = vi.fn(
          (expectedCatalog: string | null, nextCatalog: string) => {
            if (nativeCatalog !== expectedCatalog) return false;
            nativeCatalog = nextCatalog;
            return true;
          },
        );
        installTauriHarness({
          nativeConnectionCatalog: () => nativeCatalog,
          compareAndSetConnectionCatalog,
          compareConnectionCatalog: (expected) => nativeCatalog === expected,
        });
        Object.assign(window, { localStorage });
        vi.stubGlobal("localStorage", localStorage);
        yield* Effect.promise(() => installBridge());

        const decisions = yield* Effect.gen(function* () {
          const identities = yield* AcceptedStorageIdentityStore;
          const transition = (reported: string | null) =>
            identities.transition("bearer:sensitive-connection", (accepted) => ({
              result: decideStorageIdentity(accepted, reported),
              mutation: { _tag: "Keep" as const },
            }));
          const accepted = yield* transition("sensitive-store-id");
          const unverifiable = yield* transition(null);
          const changed = yield* verifyPreparedStorageIdentity(
            sensitivePrepared("different-store-id"),
          ).pipe(Effect.result);
          return { accepted, unverifiable, changed };
        }).pipe(Effect.provide(connectionStorageLayer));

        expect(decisions.accepted).toEqual({ _tag: "Accepted", value: "sensitive-store-id" });
        expect(decisions.unverifiable).toEqual({
          _tag: "Unverifiable",
          accepted: "sensitive-store-id",
        });
        expect(decisions.changed).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "ConnectionStorageChangedError",
            acceptedStorageInstanceId: "sensitive-store-id",
            reportedStorageInstanceId: "different-store-id",
          },
        });
        expect(compareAndSetConnectionCatalog).toHaveBeenCalledTimes(1);
        expect(storage.has("bibcode.connectionCatalog")).toBe(false);
      }),
  );

  it("preserves a concurrent native winner while collapsing a protected legacy catalog", async () => {
    const storage = new Map<string, string>([
      ["bibcode.connectionCatalog", SENSITIVE_CONNECTION_CATALOG],
    ]);
    const localStorage = {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
      removeItem: vi.fn((key: string) => storage.delete(key)),
    };
    const nativeWinner = "native-concurrent-winner";
    let nativeCatalog: string | null = null;
    const compareAndSetConnectionCatalog = vi.fn(() => {
      nativeCatalog = nativeWinner;
      return false;
    });
    installTauriHarness({
      nativeConnectionCatalog: () => nativeCatalog,
      compareAndSetConnectionCatalog,
    });
    Object.assign(window, { localStorage });
    vi.stubGlobal("localStorage", localStorage);

    const bridge = await installBridge();

    expect(nativeCatalog).toBe(nativeWinner);
    await expect(bridge.getConnectionCatalog!()).resolves.toBe(nativeWinner);
    expect(compareAndSetConnectionCatalog).toHaveBeenCalledOnce();
    expect(storage.has("bibcode.connectionCatalog")).toBe(false);
  });

  it("keeps an existing native catalog authoritative over a stale renderer copy", async () => {
    const storage = new Map<string, string>([
      ["bibcode.connectionCatalog", SENSITIVE_CONNECTION_CATALOG],
    ]);
    const localStorage = {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
      removeItem: vi.fn((key: string) => storage.delete(key)),
    };
    const compareAndSetConnectionCatalog = vi.fn(() => false);
    const harness = installTauriHarness({
      nativeConnectionCatalog: "native-existing-winner",
      compareAndSetConnectionCatalog,
    });
    Object.assign(window, { localStorage });
    vi.stubGlobal("localStorage", localStorage);

    const bridge = await installBridge();

    await expect(bridge.getConnectionCatalog!()).resolves.toBe("native-existing-winner");
    expect(compareAndSetConnectionCatalog).not.toHaveBeenCalled();
    expect(storage.has("bibcode.connectionCatalog")).toBe(false);
    const nativeRead = harness.invoke.mock.invocationCallOrder.find(
      (_, index) =>
        harness.invoke.mock.calls[index]?.[0] === "desktop_bridge_get_connection_catalog",
    );
    expect(nativeRead).toBeLessThan(localStorage.removeItem.mock.invocationCallOrder[0]!);
  });

  effectIt.effect("fails protected catalog migration closed without changing either source", () =>
    Effect.gen(function* () {
      const indexedDb = new IDBFactory();
      vi.stubGlobal("indexedDB", indexedDb);
      const storage = new Map<string, string>([
        ["bibcode.connectionCatalog", SENSITIVE_CONNECTION_CATALOG],
      ]);
      const localStorage = {
        getItem: vi.fn((key: string) => storage.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
        removeItem: vi.fn((key: string) => storage.delete(key)),
      };
      let nativeCatalog: string | null = null;
      installTauriHarness({
        nativeConnectionCatalog: () => nativeCatalog,
        rejectConnectionCatalogCompareAndSet: new Error(
          "DPAPI failed for C:\\Users\\alice with secret-bearer-token",
        ),
      });
      Object.assign(window, { localStorage });
      vi.stubGlobal("localStorage", localStorage);

      const bridge = yield* Effect.promise(() => installBridge());
      const bridgeResult = yield* Effect.promise(() =>
        bridge.getConnectionCatalog!().then(
          () => "resolved",
          (error: unknown) => String(error),
        ),
      );
      const persistenceResult = yield* Effect.gen(function* () {
        const identities = yield* AcceptedStorageIdentityStore;
        yield* identities.accept({
          targetKey: "platform:primary",
          storageInstanceId: "must-not-be-persisted",
        });
      }).pipe(Effect.provide(connectionStorageLayer), Effect.result);

      expect(bridgeResult).toContain("protection capability could not be verified");
      expect(bridgeResult).not.toContain("secret-bearer-token");
      expect(bridgeResult).not.toContain("C:\\Users\\alice");
      expect(persistenceResult._tag).toBe("Failure");
      if (persistenceResult._tag === "Failure") {
        expect(persistenceResult.failure).toBeInstanceOf(ConnectionTransientError);
        expect(String(persistenceResult.failure)).not.toContain("secret-bearer-token");
        expect(String(persistenceResult.failure)).not.toContain("C:\\Users\\alice");
      }
      expect(nativeCatalog).toBeNull();
      expect(storage.get("bibcode.connectionCatalog")).toBe(SENSITIVE_CONNECTION_CATALOG);
      expect(localStorage.removeItem).not.toHaveBeenCalled();
      expect(yield* Effect.promise(() => readIndexedDbConnectionCatalog(indexedDb))).toBeNull();
    }),
  );

  it("fails protected catalog initialization closed when the renderer legacy source is unreadable", async () => {
    const localStorage = {
      getItem: vi.fn(() => {
        throw new Error("renderer storage failed with secret-bearer-token");
      }),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    const compareAndSetConnectionCatalog = vi.fn(() => true);
    installTauriHarness({
      nativeConnectionCatalog: null,
      compareAndSetConnectionCatalog,
    });
    Object.assign(window, { localStorage });
    vi.stubGlobal("localStorage", localStorage);

    const bridge = await installBridge();
    const result = await bridge.getConnectionCatalog!().then(
      () => "resolved",
      (error: unknown) => String(error),
    );

    expect(result).toContain("protection capability could not be verified");
    expect(result).not.toContain("secret-bearer-token");
    expect(compareAndSetConnectionCatalog).not.toHaveBeenCalled();
    expect(localStorage.removeItem).not.toHaveBeenCalled();
  });

  it.each([
    { name: "absent", legacy: null },
    { name: "blank", legacy: "   " },
  ])("publishes native-only catalog operations for a $name renderer value", async ({ legacy }) => {
    const storage = new Map<string, string>();
    if (legacy !== null) storage.set("bibcode.connectionCatalog", legacy);
    const localStorage = {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
      removeItem: vi.fn((key: string) => storage.delete(key)),
    };
    const compareAndSetConnectionCatalog = vi.fn(() => true);
    installTauriHarness({
      nativeConnectionCatalog: null,
      compareAndSetConnectionCatalog,
      compareConnectionCatalog: (expected) => expected === null,
    });
    Object.assign(window, { localStorage });
    vi.stubGlobal("localStorage", localStorage);

    const bridge = await installBridge();

    await expect(bridge.getConnectionCatalog!()).resolves.toBeNull();
    await expect(bridge.compareConnectionCatalog!(null)).resolves.toBe(true);
    expect(compareAndSetConnectionCatalog).not.toHaveBeenCalled();
    expect(storage.has("bibcode.connectionCatalog")).toBe(false);
  });

  it("omits native catalog mutation methods when protected CAS is unavailable", async () => {
    installTauriHarness({ protectedConnectionCatalog: false });
    const bridge = await installBridge();

    expect(bridge.getConnectionCatalog).toBeDefined();
    expect(bridge.clearConnectionCatalog).toBeDefined();
    expect(bridge.setConnectionCatalog).toBeUndefined();
    expect(bridge.compareAndSetConnectionCatalog).toBeUndefined();
    expect(bridge.compareConnectionCatalog).toBeUndefined();
  });

  effectIt.effect.each([
    {
      name: "the metadata command rejects",
      options: {
        rejectMetadata: true,
        metadataError: new Error(
          "metadata failed with secret-bearer-token at /Users/alice/private/catalog.json",
        ),
      },
    },
    {
      name: "the host reports bridge version 1",
      options: { bridgeVersion: 1 },
    },
    {
      name: "the host reports bridge version 2 without compare-only support",
      options: { bridgeVersion: 2 },
    },
    {
      name: "the protected-catalog feature is missing",
      options: { omitProtectedConnectionCatalog: true },
    },
  ])("fails catalog mutation closed when $name", ({ options }) =>
    Effect.gen(function* () {
      const indexedDb = new IDBFactory();
      vi.stubGlobal("indexedDB", indexedDb);
      let nativeCatalog: string | null = SENSITIVE_CONNECTION_CATALOG;
      const browserStorage = new Map<string, string>([
        ["bibcode.connectionCatalog", SENSITIVE_CONNECTION_CATALOG],
      ]);
      const localStorage = {
        getItem: vi.fn((key: string) => browserStorage.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => browserStorage.set(key, value)),
        removeItem: vi.fn((key: string) => browserStorage.delete(key)),
      };
      const harness = installTauriHarness({
        ...options,
        nativeConnectionCatalog: () => nativeCatalog,
        compareAndSetConnectionCatalog: (expected, next) => {
          if (nativeCatalog !== expected) return false;
          nativeCatalog = next;
          return true;
        },
        clearConnectionCatalog: () => {
          nativeCatalog = null;
        },
      });
      Object.assign(window, { localStorage });
      vi.stubGlobal("localStorage", localStorage);
      yield* Effect.promise(() => installBridge());

      const result = yield* Effect.gen(function* () {
        const identityStore = yield* AcceptedStorageIdentityStore;
        yield* identityStore.accept({
          targetKey: "platform:primary",
          storageInstanceId: "must-not-be-persisted",
        });
      }).pipe(Effect.provide(connectionStorageLayer), Effect.result);

      expect
        .soft(yield* Effect.promise(() => readIndexedDbConnectionCatalog(indexedDb)))
        .toBeNull();
      expect.soft(nativeCatalog).toBe(SENSITIVE_CONNECTION_CATALOG);
      expect
        .soft(browserStorage.get("bibcode.connectionCatalog"))
        .toBe(SENSITIVE_CONNECTION_CATALOG);
      expect
        .soft(harness.invoke)
        .not.toHaveBeenCalledWith("desktop_bridge_clear_connection_catalog", undefined);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toBeInstanceOf(ConnectionTransientError);
        expect(result.failure.message).toContain("Could not migrate the local connection catalog");
        expect(result.failure.message).not.toContain("secret-bearer-token");
        expect(result.failure.message).not.toContain("secret-dpop-token");
        expect(result.failure.message).not.toContain("/Users/alice");
        expect(result.failure.message).not.toContain("private.example.test");
      }
    }),
  );

  it("normalizes structured unsupported errors returned by Tauri commands", async () => {
    installTauriHarness({ rejectSshProvisioning: true });
    const bridge = await installBridge();

    await expect(
      bridge.ensureSshEnvironment({
        alias: "host-2",
        hostname: "example.test",
        username: null,
        port: null,
      }),
    ).rejects.toMatchObject({
      name: "TauriDesktopCapabilityUnsupportedError",
      code: "tauri_capability_unsupported",
      method: "ensureSshEnvironment",
      capability: "sshProvisioning",
    });
  });

  it("routes context menus through the Tauri host command", async () => {
    const harness = installTauriHarness({ contextMenuResult: "open" });
    const bridge = await installBridge();
    const items = [{ id: "open", label: "Open" }] as const;

    await expect(bridge.showContextMenu(items, { x: 10, y: 20 })).resolves.toBe("open");

    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_show_context_menu", {
      items,
      position: { x: 10, y: 20 },
    });
    expect(showContextMenuFallbackMock).not.toHaveBeenCalled();
  });

  it("uses the web context menu when the Windows native popup cannot report failure", async () => {
    const harness = installTauriHarness({ contextMenuResult: null });
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    });
    showContextMenuFallbackMock.mockResolvedValue("delete-worktree");
    const bridge = await installBridge();
    const items = [{ id: "delete-worktree", label: "Delete Worktree" }] as const;

    await expect(bridge.showContextMenu(items, { x: 30, y: 40 })).resolves.toBe("delete-worktree");

    expect(harness.invoke).not.toHaveBeenCalledWith(
      "desktop_bridge_show_context_menu",
      expect.anything(),
    );
    expect(showContextMenuFallbackMock).toHaveBeenCalledWith(items, { x: 30, y: 40 });
  });

  it("falls back to the web context menu when Tauri reports native context menus unsupported", async () => {
    const harness = installTauriHarness({ rejectContextMenu: unsupportedContextMenuError });
    showContextMenuFallbackMock.mockResolvedValue("rename");
    const bridge = await installBridge();
    const items = [{ id: "rename", label: "Rename" }] as const;

    await expect(bridge.showContextMenu(items, { x: 30, y: 40 })).resolves.toBe("rename");

    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_show_context_menu", {
      items,
      position: { x: 30, y: 40 },
    });
    expect(showContextMenuFallbackMock).toHaveBeenCalledWith(items, { x: 30, y: 40 });
  });

  it("does not hide unexpected Tauri context menu errors behind the web fallback", async () => {
    const hostError = new Error("native menu crashed");
    installTauriHarness({ rejectContextMenu: hostError });
    const bridge = await installBridge();

    await expect(bridge.showContextMenu([{ id: "open", label: "Open" }])).rejects.toBe(hostError);
    expect(showContextMenuFallbackMock).not.toHaveBeenCalled();
  });

  it("returns disabled updater results through Tauri commands", async () => {
    const harness = installTauriHarness();
    const bridge = await installBridge();

    await expect(bridge.checkForUpdate()).resolves.toEqual({
      checked: false,
      state: { status: "disabled" },
    });
    await expect(bridge.downloadUpdate()).resolves.toEqual({
      accepted: false,
      completed: false,
      state: { status: "disabled" },
    });
    await expect(bridge.installUpdate()).resolves.toEqual({
      accepted: false,
      completed: false,
      state: { status: "disabled" },
    });
    await expect(bridge.installUpdate({ excludedEnvironmentIds: ["wsl:Ubuntu"] })).resolves.toEqual(
      {
        accepted: false,
        completed: false,
        state: { status: "disabled" },
      },
    );

    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_check_for_update", undefined);
    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_download_update", undefined);
    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_install_update", undefined);
    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_install_update", {
      input: { excludedEnvironmentIds: ["wsl:Ubuntu"] },
    });
  });

  it("saves diagnostic archives through the Tauri host", async () => {
    const harness = installTauriHarness();
    const bridge = await installBridge();

    await expect(
      bridge.saveDiagnosticLogs?.("diagnostics.zip", new Uint8Array([0x50, 0x4b])),
    ).resolves.toBe("C:\\Users\\test\\Downloads\\diagnostics.zip");
    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_save_diagnostic_logs", {
      filename: "diagnostics.zip",
      bytes: [0x50, 0x4b],
    });
  });

  it("routes privileged project-data recovery using identifiers rather than renderer paths", async () => {
    const harness = installTauriHarness();
    const bridge = await installBridge();

    await expect(bridge.getProjectDataStatuses?.()).resolves.toBeNull();
    await expect(
      bridge.restoreProjectData?.("primary", "26b6ca53-27d3-401a-b51f-d7bdf534081f"),
    ).resolves.toBeNull();
    await expect(bridge.startEmptyProjectData?.("primary")).resolves.toBeNull();
    await expect(bridge.retryProjectData?.("primary")).resolves.toBeNull();
    await expect(bridge.openProjectDataPath?.("primary")).resolves.toBeNull();
    await expect(bridge.exportProjectDataDiagnostics?.("primary")).resolves.toBeNull();

    expect(harness.invoke).toHaveBeenCalledWith(
      "desktop_bridge_get_project_data_statuses",
      undefined,
    );
    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_restore_project_data", {
      environmentId: "primary",
      backupId: "26b6ca53-27d3-401a-b51f-d7bdf534081f",
    });
    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_start_empty_project_data", {
      environmentId: "primary",
    });
    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_retry_project_data", {
      environmentId: "primary",
    });
    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_open_project_data_path", {
      environmentId: "primary",
    });
    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_export_project_data_diagnostics", {
      environmentId: "primary",
    });
  });

  it("forwards project data status invalidations and disposes the native listener", async () => {
    const harness = installTauriHarness();
    const bridge = await installBridge();
    const received: unknown[] = [];

    const dispose = bridge.onProjectDataStatusChanged?.((event) => received.push(event));
    expect(dispose).toEqual(expect.any(Function));
    await Promise.resolve();

    expect(harness.listen).toHaveBeenCalledWith(
      "desktop:project-data-status-changed",
      expect.any(Function),
    );
    harness.listeners.get("desktop:project-data-status-changed")?.({
      payload: { environmentId: "primary" },
    });
    expect(received).toEqual([{ environmentId: "primary" }]);

    dispose?.();
    await Promise.resolve();
    expect(harness.unlisteners.get("desktop:project-data-status-changed")).toHaveBeenCalledTimes(1);
  });

  it("routes the remaining desktop bridge capabilities through Tauri commands", async () => {
    const harness = installTauriHarness();
    const bridge = await installBridge();
    const sshTarget = {
      alias: "host-1",
      hostname: "example.test",
      username: null,
      port: null,
    };

    await expect(bridge.getClientSettings()).resolves.toBeNull();
    await expect(bridge.setClientSettings({} as never)).resolves.toBeNull();
    await expect(bridge.discoverSshHosts()).resolves.toBeNull();
    await expect(
      bridge.disconnectSshEnvironment(sshTarget, {
        expectedHostKeyFingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      }),
    ).resolves.toBeNull();
    await expect(
      bridge.cancelSshOperation?.({
        target: sshTarget,
        operationId: "019d2a2e-0d0e-7000-8000-000000000013",
        environmentGeneration: 8,
        bindingGeneration: 21,
      }),
    ).resolves.toBeNull();
    await expect(bridge.resolveSshPasswordPrompt?.("request-1", "secret")).resolves.toBeNull();
    await expect(bridge.getServerExposureState()).resolves.toBeNull();
    await expect(
      bridge.setTailscaleServeEnabled({ enabled: true, port: 8443 }),
    ).resolves.toBeNull();
    await expect(bridge.getAdvertisedEndpoints()).resolves.toBeNull();
    await expect(bridge.getWslState()).resolves.toEqual(defaultWslState);
    await expect(bridge.setWslBackendEnabled(true)).resolves.toBeNull();
    await expect(bridge.setWslDistro("Ubuntu")).resolves.toBeNull();
    await expect(bridge.setWslOnly(true)).resolves.toBeNull();
    await expect(bridge.pickFolder({ initialPath: "/workspace" })).resolves.toBeNull();
    await expect(bridge.confirm("Continue?")).resolves.toBeNull();
    await expect(bridge.setTheme("dark")).resolves.toBeNull();
    await expect(bridge.openExternal("https://example.test")).resolves.toBeNull();
    await expect(
      (
        bridge as DesktopBridge & {
          openInFileManager: (path: string, isDirectory: boolean) => Promise<void>;
        }
      ).openInFileManager("C:\\workspace\\demo\\src", true),
    ).resolves.toBeNull();
    await expect(bridge.getUpdateState()).resolves.toBeNull();

    const passwordRequests: unknown[] = [];
    const disposePasswordPrompt = bridge.onSshPasswordPrompt?.((request) =>
      passwordRequests.push(request),
    );
    await Promise.resolve();
    harness.listeners.get("desktop:ssh-password-prompt")?.({
      payload: { requestId: "request-1", prompt: "Password" },
    });
    expect(passwordRequests).toEqual([{ requestId: "request-1", prompt: "Password" }]);
    disposePasswordPrompt?.();

    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_get_client_settings", undefined);
    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_discover_ssh_hosts", undefined);
    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_disconnect_ssh_environment", {
      target: sshTarget,
      options: {
        expectedHostKeyFingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
    });
    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_cancel_ssh_operation", {
      input: {
        target: sshTarget,
        operationId: "019d2a2e-0d0e-7000-8000-000000000013",
        environmentGeneration: 8,
        bindingGeneration: 21,
      },
    });
    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_set_wsl_backend_enabled", {
      enabled: true,
    });
    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_open_in_file_manager", {
      path: "C:\\workspace\\demo\\src",
      isDirectory: true,
    });
  });

  it("decodes WSL discovery and setup events and exposes generation-fenced commands", async () => {
    const harness = installTauriHarness();
    const bridge = await installBridge();
    const discoveries: unknown[] = [];
    const progress: unknown[] = [];

    await expect(bridge.refreshWslDiscovery?.()).resolves.toEqual(defaultWslState);
    await expect(
      bridge.prepareWslServer?.({ distro: "Ubuntu", discoveryGeneration: 7 }),
    ).resolves.toMatchObject({ distro: "Ubuntu", probeGeneration: 7 });
    await expect(
      bridge.installWslServer?.({ requestId: "wsl-setup-1", probeGeneration: 7, accepted: false }),
    ).resolves.toMatchObject({ status: "cancelled", generation: 7 });
    await expect(
      bridge.cancelWslSetup?.({ requestId: "wsl-setup-1", generation: 7 }),
    ).resolves.toBe(true);

    const disposeDiscovery = bridge.onWslDiscoveryChanged?.((event) => discoveries.push(event));
    const disposeProgress = bridge.onRemoteSetupProgress?.((event) => progress.push(event));
    await Promise.resolve();

    harness.listeners.get("desktop:wsl-discovery-changed")?.({
      payload: defaultWslDiscovery,
    });
    harness.listeners.get("desktop:remote-setup-progress")?.({
      payload: {
        requestId: "wsl-setup-1",
        generation: 7,
        stage: "download",
        status: "running",
        completedBytes: 5,
        totalBytes: 10,
        message: null,
      },
    });
    harness.listeners.get("desktop:wsl-discovery-changed")?.({
      payload: { ...defaultWslDiscovery, generation: -1 },
    });
    harness.listeners.get("desktop:remote-setup-progress")?.({
      payload: {
        requestId: "wsl-setup-1",
        generation: 7,
        stage: "download",
        status: "running",
        completedBytes: 11,
        totalBytes: 10,
        message: null,
      },
    });

    expect(discoveries).toEqual([defaultWslDiscovery]);
    expect(progress).toEqual([
      expect.objectContaining({ requestId: "wsl-setup-1", completedBytes: 5 }),
    ]);
    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_refresh_wsl_discovery", undefined);
    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_prepare_wsl_server", {
      input: { distro: "Ubuntu", discoveryGeneration: 7 },
    });
    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_install_wsl_server", {
      input: { requestId: "wsl-setup-1", probeGeneration: 7, accepted: false },
    });
    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_cancel_wsl_setup", {
      input: { requestId: "wsl-setup-1", generation: 7 },
    });

    disposeDiscovery?.();
    disposeProgress?.();
    await Promise.resolve();
    expect(harness.unlisteners.get("desktop:wsl-discovery-changed")).toHaveBeenCalledTimes(1);
    expect(harness.unlisteners.get("desktop:remote-setup-progress")).toHaveBeenCalledTimes(1);
  });

  it("decodes identity-bound environment removal plans and verified effects", async () => {
    const harness = installTauriHarness();
    const bridge = await installBridge();
    const target = { transport: "wsl" as const, distro: "Ubuntu", discoveryGeneration: 7 };
    const input = {
      target,
      expectedEnvironmentId: EnvironmentId.make("76aa78e8-67aa-477e-bd25-68f491885224"),
      expectedStorageId: "3039b232-95d0-4b2f-a35e-c297b4c895af",
      environmentName: "Build host",
    };
    const plan = await bridge.planEnvironmentRemoval?.(input);
    expect(plan).toMatchObject({ environmentName: "Build host", uninstallSupported: true });
    await expect(
      bridge.executeEnvironmentRemoval?.({ action: "uninstall", target, plan: plan! }),
    ).resolves.toMatchObject({
      action: "uninstall",
      dataRootPreserved: true,
      verified: true,
    });
    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_plan_environment_removal", {
      input,
    });
    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_execute_environment_removal", {
      input: { action: "uninstall", target, plan },
    });
  });

  it("wraps Tauri event listeners and tears them down", async () => {
    const harness = installTauriHarness();
    const bridge = await installBridge();
    const menuActions: string[] = [];
    const updateStates: unknown[] = [];

    const disposeMenu = bridge.onMenuAction((action) => menuActions.push(action));
    const disposeUpdate = bridge.onUpdateState((state) => updateStates.push(state));
    await Promise.resolve();

    expect(harness.listen).toHaveBeenCalledWith("desktop:menu-action", expect.any(Function));
    expect(harness.listen).toHaveBeenCalledWith("desktop:update-state", expect.any(Function));

    harness.listeners.get("desktop:menu-action")?.({ payload: "open-settings" });
    harness.listeners.get("desktop:update-state")?.({
      payload: { status: "checking" },
    });

    expect(menuActions).toEqual(["open-settings"]);
    expect(updateStates).toEqual([{ status: "checking" }]);

    disposeMenu();
    disposeUpdate();
    await Promise.resolve();

    expect(harness.unlisteners.get("desktop:menu-action")).toHaveBeenCalledTimes(1);
    expect(harness.unlisteners.get("desktop:update-state")).toHaveBeenCalledTimes(1);
  });

  it("refreshes cached local bootstraps and bearer tokens from backend-ready events without reinstalling the bridge", async () => {
    const harness = installTauriHarness({
      localEnvironmentBootstraps: [
        {
          id: "primary",
          label: "Local",
          httpBaseUrl: "http://127.0.0.1:3773",
          wsBaseUrl: "ws://127.0.0.1:3773",
          bootstrapToken: "bootstrap-token-1",
        },
      ],
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body ?? ""));
      const subjectToken = body.get("subject_token");
      return {
        ok: true,
        json: async () => ({ access_token: `bearer-for-${subjectToken}` }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const bridge = await installBridge();
    await Promise.resolve();

    expect(harness.listen).toHaveBeenCalledWith("desktop:backend-ready", expect.any(Function));
    expect(await bridge.getLocalEnvironmentBearerToken()).toBe("bearer-for-bootstrap-token-1");
    expect(bridge.getLocalEnvironmentBootstraps()).toEqual([
      {
        id: "primary",
        label: "Local",
        httpBaseUrl: "http://127.0.0.1:3773",
        wsBaseUrl: "ws://127.0.0.1:3773",
        bootstrapToken: "bootstrap-token-1",
      },
    ]);

    const originalBridge = window.desktopBridge;
    harness.listeners.get("desktop:backend-ready")?.({
      payload: {
        reason: "restarted",
        bootstraps: [
          {
            id: "primary",
            label: "Local",
            httpBaseUrl: "http://127.0.0.1:4888",
            wsBaseUrl: "ws://127.0.0.1:4888",
            bootstrapToken: "bootstrap-token-2",
          },
        ],
      },
    });

    expect(window.desktopBridge).toBe(originalBridge);
    expect(bridge.getLocalEnvironmentBootstraps()).toEqual([
      {
        id: "primary",
        label: "Local",
        httpBaseUrl: "http://127.0.0.1:4888",
        wsBaseUrl: "ws://127.0.0.1:4888",
        bootstrapToken: "bootstrap-token-2",
      },
    ]);
    expect(await bridge.getLocalEnvironmentBearerToken()).toBe("bearer-for-bootstrap-token-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses browser fallbacks when optional native capabilities reject", async () => {
    const storage = new Map<string, string>([["bibcode.connectionCatalog", "browser-catalog"]]);
    const localStorage = {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
      removeItem: vi.fn((key: string) => storage.delete(key)),
    };
    const harness = installTauriHarness({
      rejectFallbackCommands: true,
      protectedConnectionCatalog: false,
    });
    Object.assign(window, {
      confirm: vi.fn(() => true),
      open: vi.fn(),
      localStorage,
    });
    vi.stubGlobal("localStorage", localStorage);
    const bridge = await installBridge();

    await expect(bridge.getClientSettings()).resolves.toBeNull();
    await expect(bridge.setClientSettings(DEFAULT_CLIENT_SETTINGS)).resolves.toBeUndefined();
    await expect(bridge.getClientSettings()).resolves.toEqual(DEFAULT_CLIENT_SETTINGS);
    await expect(bridge.getConnectionCatalog!()).resolves.toBe("browser-catalog");
    expect(bridge.setConnectionCatalog).toBeUndefined();
    expect(bridge.compareAndSetConnectionCatalog).toBeUndefined();
    await expect(bridge.clearConnectionCatalog!()).resolves.toBeUndefined();
    await expect(bridge.discoverSshHosts()).resolves.toEqual([]);
    await expect(
      bridge.disconnectSshEnvironment(
        {
          alias: "fallback",
          hostname: "fallback.test",
          username: null,
          port: null,
        },
        {
          expectedHostKeyFingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        },
      ),
    ).resolves.toBeUndefined();
    await expect(bridge.getAdvertisedEndpoints()).resolves.toEqual([]);
    await expect(bridge.pickFolder()).resolves.toBeNull();
    await expect(bridge.confirm("Continue?")).resolves.toBe(true);
    await expect(bridge.setTheme("dark")).resolves.toBeUndefined();
    await expect(bridge.openExternal("https://example.test/path")).resolves.toBe(true);
    await expect(bridge.openExternal("file:///tmp/secret")).resolves.toBe(false);
    await expect(bridge.openExternal("not a URL")).resolves.toBe(false);

    await expect(bridge.getServerExposureState()).resolves.toMatchObject({ mode: "local-only" });
    await expect(
      bridge.setTailscaleServeEnabled({ enabled: true, port: 8443 }),
    ).resolves.toMatchObject({ tailscaleServeEnabled: false });
    await expect(bridge.getWslState()).resolves.toMatchObject({ enabled: false, distros: [] });
    await expect(bridge.setWslBackendEnabled(true)).resolves.toMatchObject({ enabled: false });
    await expect(bridge.setWslDistro("Ubuntu")).resolves.toMatchObject({ distro: null });
    await expect(bridge.setWslOnly(true)).resolves.toMatchObject({ wslOnly: false });
    await expect(bridge.getUpdateState()).resolves.toEqual({
      enabled: false,
      status: "disabled",
      currentVersion: import.meta.env.APP_VERSION || "0.0.0",
      hostArch: "other",
      appArch: "other",
      runningUnderArm64Translation: false,
      availableVersion: null,
      downloadedVersion: null,
      downloadPercent: null,
      checkedAt: null,
      message: null,
      errorContext: null,
      canRetry: false,
    });

    expect(window.open).toHaveBeenCalledWith(
      "https://example.test/path",
      "_blank",
      "noopener,noreferrer",
    );
    expect(localStorage.removeItem).toHaveBeenCalled();
    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_get_update_state", undefined);
  });

  it("fails closed when browser catalog storage and event subscription are unavailable", async () => {
    const localStorage = {
      getItem: vi.fn(() => {
        throw new Error("storage blocked");
      }),
      setItem: vi.fn(() => {
        throw new Error("storage blocked");
      }),
      removeItem: vi.fn(() => {
        throw new Error("storage blocked");
      }),
    };
    installTauriHarness({
      rejectFallbackCommands: true,
      rejectListeners: true,
      protectedConnectionCatalog: false,
    });
    Object.assign(window, { localStorage });
    vi.stubGlobal("localStorage", localStorage);
    const bridge = await installBridge();

    await expect(bridge.getConnectionCatalog!()).resolves.toBeNull();
    expect(bridge.setConnectionCatalog).toBeUndefined();
    await expect(bridge.clearConnectionCatalog!()).resolves.toBeUndefined();
    const dispose = bridge.onMenuAction(() => {
      throw new Error("listener must stay inactive");
    });
    dispose();
    await Promise.resolve();

    expect(localStorage.getItem).toHaveBeenCalled();
    expect(localStorage.removeItem).toHaveBeenCalled();
  });

  it("retries bearer-token exchange after HTTP and payload failures", async () => {
    installTauriHarness();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "recovered" }) });
    vi.stubGlobal("fetch", fetchMock);
    const bridge = await installBridge();

    await expect(bridge.getLocalEnvironmentBearerToken()).rejects.toThrowError(/failed: 503/u);
    await expect(bridge.getLocalEnvironmentBearerToken()).rejects.toThrowError(
      /did not include a token/u,
    );
    await expect(bridge.getLocalEnvironmentBearerToken()).resolves.toBe("recovered");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
