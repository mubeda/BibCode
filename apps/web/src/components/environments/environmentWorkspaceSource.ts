import type { EnvironmentPresentation, KnownEnvironment } from "@bibcode/client-runtime/connection";
import { serverUpdateBlocksMutations } from "@bibcode/client-runtime/operations";
import type { EnvironmentAvailabilityStatus } from "@bibcode/client-runtime/state/shell";
import type {
  AuthAccessSnapshot,
  OrchestrationShellSnapshot,
  ServerBindPosture,
} from "@bibcode/contracts";
import * as DateTime from "effect/DateTime";

import type {
  EnvironmentHostAuthorityChannel,
  EnvironmentWorkspaceRouteSource,
  EnvironmentWorkspaceSource,
  EnvironmentWorkspaceStatus,
} from "./environmentWorkspaceModel";

export interface BuildEnvironmentWorkspaceSourceInput {
  readonly environment: KnownEnvironment;
  readonly presentation: EnvironmentPresentation;
  readonly shellStatus: EnvironmentAvailabilityStatus;
  readonly shellSnapshot: OrchestrationShellSnapshot | null;
  readonly activeRouteId: string | null;
  readonly desktopBridgeAvailable: boolean;
  readonly authAccessSnapshot?: AuthAccessSnapshot | null;
}

function routeAddress(route: KnownEnvironment["routes"][number]): string {
  switch (route._tag) {
    case "DesktopLoopbackRoute":
      return route.httpBaseUrl;
    case "DesktopWslRoute":
      return `${route.httpBaseUrl} · ${route.bindingId}`;
    case "SshTunnelRoute": {
      const authority = route.target.username
        ? `${route.target.username}@${route.target.hostname}`
        : route.target.hostname;
      return route.target.port === null ? authority : `${authority}:${route.target.port}`;
    }
    case "DirectHttpsRoute":
      return route.httpsBaseUrl;
  }
}

function routeTrust(route: KnownEnvironment["routes"][number]): string {
  switch (route._tag) {
    case "DesktopLoopbackRoute":
    case "DesktopWslRoute":
      return "Desktop-owned loopback";
    case "SshTunnelRoute":
      return route.hostKeyFingerprint ?? "Host key not yet verified";
    case "DirectHttpsRoute":
      return route.trust._tag === "System"
        ? "Operating-system certificate trust"
        : `SPKI SHA-256 ${route.trust.sha256}`;
  }
}

function projectRoute(route: KnownEnvironment["routes"][number]): EnvironmentWorkspaceRouteSource {
  return {
    routeId: route.routeId,
    label: route.label,
    kind:
      route._tag === "DesktopLoopbackRoute"
        ? "desktop"
        : route._tag === "DesktopWslRoute"
          ? "wsl"
          : route._tag === "SshTunnelRoute"
            ? "ssh"
            : "https",
    address: routeAddress(route),
    priority: route.priority,
    pinned: route.pinned,
    autoconnect: route.autoconnect,
    trust: routeTrust(route),
  };
}

function environmentStatus(
  input: BuildEnvironmentWorkspaceSourceInput,
): EnvironmentWorkspaceStatus {
  const updatePhase = input.presentation.serverConfig?.service?.update.phase ?? null;
  if (serverUpdateBlocksMutations(updatePhase)) return "updating";

  const target = input.presentation.entry.target;
  if (target._tag === "UnavailableConnectionTarget" && target.configuredDistro !== null) {
    return target.detail.toLocaleLowerCase().includes("stopped") ? "stopped" : "setup-required";
  }
  const error = input.presentation.connection.error?.toLocaleLowerCase() ?? "";
  if (error.includes("version") && error.includes("incompat")) return "version-incompatible";
  if (error.includes("authentication") || error.includes("credential")) {
    return "authentication-required";
  }
  switch (input.presentation.connection.phase) {
    case "connecting":
      return "connecting";
    case "reconnecting":
      return "reconnecting";
    case "offline":
    case "error":
      return "offline";
    case "connected":
      return input.shellStatus === "live" ? "online" : "connecting";
    case "available":
      return input.shellStatus === "live" ? "online" : "offline";
  }
}

function hostAuthorityChannels(
  input: BuildEnvironmentWorkspaceSourceInput,
): readonly EnvironmentHostAuthorityChannel[] {
  if (!input.desktopBridgeAvailable) return [];
  const activeRoute = input.environment.routes.find(
    (route) => route.routeId === input.activeRouteId,
  );
  return activeRoute?._tag === "SshTunnelRoute" ? ["desktop", "sshAdmin"] : ["desktop"];
}

function formatBind(bind: ServerBindPosture): string {
  return `${bind.scope} · ${bind.transport.toUpperCase()} · ${bind.port}`;
}

export function buildEnvironmentWorkspaceSource(
  input: BuildEnvironmentWorkspaceSourceInput,
): EnvironmentWorkspaceSource {
  const descriptor = input.environment.descriptor ?? input.presentation.serverConfig?.environment;
  if (descriptor === undefined || descriptor === null) {
    throw new Error("The environment has not provided a verified identity descriptor.");
  }
  const service = input.presentation.serverConfig?.service;
  const platformDetails = input.environment.bindings.map((binding) =>
    binding._tag === "DesktopWslBinding"
      ? {
          label: `WSL ${binding.distroName}`,
          value: binding.condition.replaceAll("-", " "),
        }
      : {
          label: "Desktop primary binding",
          value: binding.condition.replaceAll("-", " "),
        },
  );

  return {
    environmentId: input.environment.environmentId,
    acceptedStorageInstanceId: input.environment.acceptedStorageInstanceId,
    alias: input.environment.alias,
    canonicalLabel: descriptor.label,
    platform: descriptor.platform,
    serverVersion: descriptor.serverVersion,
    protocol: descriptor.protocol,
    capabilities: descriptor.capabilities,
    status: environmentStatus(input),
    hasCachedContent: input.shellSnapshot !== null,
    lastSynchronizedAt: input.shellSnapshot?.updatedAt ?? null,
    projectCount: input.shellSnapshot?.projects.length ?? 0,
    threadCount: input.shellSnapshot?.threads.length ?? 0,
    projects:
      input.shellSnapshot?.projects.map((project) => ({
        title: project.title,
        workspaceRoot: project.workspaceRoot,
      })) ?? [],
    pairedClients:
      input.authAccessSnapshot?.clientSessions.map((session) => ({
        label: session.client.label ?? session.subject,
        platform:
          [session.client.deviceType, session.client.os, session.client.browser]
            .filter((value): value is string => value !== undefined && value !== "unknown")
            .join(" · ") || "Unknown client",
        dpopFingerprint: session.subject,
        issuedAt: DateTime.formatIso(session.issuedAt),
        lastConnectedAt:
          session.lastConnectedAt === null ? null : DateTime.formatIso(session.lastConnectedAt),
        current: session.current,
      })) ?? [],
    activeRouteId: input.activeRouteId,
    routes: input.environment.routes.map(projectRoute),
    service:
      service === undefined
        ? null
        : {
            mode: service.serviceMode ?? "Not configured",
            startupMechanism: service.startupMechanism,
            runtimeState: service.runtimeState,
            version: service.version,
            account:
              service.accountKind === "currentUser" ? "Current user" : "Dedicated service account",
            bind: formatBind(service.bind),
            binaryPath: null,
            dataPath: null,
            updatePhase: service.update.phase,
          },
    hostAuthorityChannels: hostAuthorityChannels(input),
    platformDetails,
  };
}
