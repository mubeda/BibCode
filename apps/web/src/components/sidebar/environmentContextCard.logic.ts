import {
  connectionStatusText,
  type CompatVerdict,
  type ConnectionTarget,
  type EnvironmentConnectionPresentation,
} from "@bibcode/client-runtime/connection";
import type { ServerConfig } from "@bibcode/contracts";

import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import {
  resolveEnvironmentCompatVerdict,
  selectRemoteUpdateControlCapability,
} from "../../connection/environmentCompat";
import { resolveEnvironmentRailStatus, type EnvironmentRailStatus } from "./environmentRail.logic";

export interface EnvironmentCompatBadge {
  readonly label: string;
  readonly tone: "warning" | "error";
}

export function resolveCompatBadge(compat: CompatVerdict | null): EnvironmentCompatBadge | null {
  if (compat === null) {
    return null;
  }
  switch (compat.kind) {
    case "compatible":
      return null;
    case "legacy":
      return { label: "Limited compatibility", tone: "warning" };
    case "server-too-old":
      return { label: "Server update required", tone: "error" };
    case "client-too-old":
      return { label: "App update required", tone: "error" };
  }
}

export interface EnvironmentContextCardView {
  readonly name: string;
  readonly status: EnvironmentRailStatus;
  readonly statusText: string;
  readonly versionLine: string | null;
  readonly compatBadge: EnvironmentCompatBadge | null;
  readonly showUpdateActions: boolean;
}

export function buildEnvironmentContextCardView(input: {
  readonly label: string;
  readonly target: ConnectionTarget;
  readonly connection: EnvironmentConnectionPresentation;
  readonly serverConfig: ServerConfig | null;
}): EnvironmentContextCardView | null {
  if (
    input.target._tag === "PrimaryConnectionTarget" ||
    isDesktopLocalConnectionTarget(input.target)
  ) {
    return null;
  }
  const compat = resolveEnvironmentCompatVerdict(input.serverConfig);
  const serverVersion = input.serverConfig?.environment.serverVersion ?? null;
  return {
    name: input.label,
    status: resolveEnvironmentRailStatus({
      phase: input.connection.phase,
      compat,
      updateAvailable: false,
    }),
    statusText: connectionStatusText(input.connection),
    versionLine: serverVersion === null ? null : `BiBCode v${serverVersion}`,
    compatBadge: resolveCompatBadge(compat),
    showUpdateActions: selectRemoteUpdateControlCapability(input.serverConfig),
  };
}
