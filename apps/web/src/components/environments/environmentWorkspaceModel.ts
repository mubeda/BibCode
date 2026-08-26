export const environmentWorkspaceTabs = [
  { id: "overview", label: "Overview" },
  { id: "connection", label: "Connection" },
  { id: "service", label: "Service" },
  { id: "security", label: "Security" },
  { id: "projects", label: "Projects & Storage" },
  { id: "updates", label: "Updates" },
  { id: "diagnostics", label: "Diagnostics" },
  { id: "platform", label: "Platform" },
] as const;

export type EnvironmentWorkspaceTab = (typeof environmentWorkspaceTabs)[number]["id"];

const environmentWorkspaceTabIds = new Set<string>(environmentWorkspaceTabs.map((tab) => tab.id));

export function parseEnvironmentWorkspaceSearch(search: { readonly tab?: unknown }): {
  readonly tab: EnvironmentWorkspaceTab;
} {
  return {
    tab:
      typeof search.tab === "string" && environmentWorkspaceTabIds.has(search.tab)
        ? (search.tab as EnvironmentWorkspaceTab)
        : "overview",
  };
}

export function parseDirectEnvironmentEndpoint(rawValue: string): string {
  const value = rawValue.trim();
  if (!/^https:\/\//iu.test(value) && !/^wss:\/\//iu.test(value)) {
    throw new Error("Enter an endpoint beginning with https:// or wss://.");
  }

  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("Enter a valid https:// or wss:// endpoint.");
  }
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "wss:") {
    throw new Error("Enter an endpoint beginning with https:// or wss://.");
  }
  if (
    endpoint.username.length > 0 ||
    endpoint.password.length > 0 ||
    endpoint.search.length > 0 ||
    endpoint.hash.length > 0
  ) {
    throw new Error("The endpoint cannot include credentials, query parameters, or fragments.");
  }
  endpoint.pathname = "/";
  return endpoint.toString();
}

export type EnvironmentWorkspaceStatus =
  | "online"
  | "connecting"
  | "reconnecting"
  | "offline"
  | "authentication-required"
  | "version-incompatible"
  | "updating"
  | "stopped"
  | "setup-required";

export type EnvironmentHostAuthorityChannel = "desktop" | "localControl" | "sshAdmin";

export interface EnvironmentWorkspaceRouteSource {
  readonly routeId: string;
  readonly label: string;
  readonly kind: "desktop" | "wsl" | "ssh" | "https";
  readonly address: string;
  readonly priority: number;
  readonly pinned: boolean;
  readonly autoconnect: boolean;
  readonly trust: string;
}

export interface EnvironmentWorkspaceServiceSource {
  readonly mode: string;
  readonly startupMechanism: string;
  readonly runtimeState: string;
  readonly version: string;
  readonly account: string;
  readonly bind: string;
  readonly binaryPath: string | null;
  readonly dataPath: string | null;
  readonly updatePhase: string;
}

export interface EnvironmentWorkspaceSource {
  readonly environmentId: string;
  readonly acceptedStorageInstanceId: string;
  readonly alias: string | null;
  readonly canonicalLabel: string;
  readonly platform: { readonly os: string; readonly arch: string };
  readonly serverVersion: string;
  readonly protocol: { readonly minimum: number; readonly maximum: number };
  readonly capabilities: Readonly<Record<string, boolean | number | string | null>>;
  readonly status: EnvironmentWorkspaceStatus;
  readonly hasCachedContent: boolean;
  readonly lastSynchronizedAt: string | null;
  readonly projectCount: number;
  readonly threadCount: number;
  readonly projects: readonly {
    readonly title: string;
    readonly workspaceRoot: string;
  }[];
  readonly pairedClients: readonly {
    readonly label: string;
    readonly platform: string;
    readonly dpopFingerprint: string;
    readonly issuedAt: string;
    readonly lastConnectedAt: string | null;
    readonly current: boolean;
  }[];
  readonly activeRouteId: string | null;
  readonly routes: readonly EnvironmentWorkspaceRouteSource[];
  readonly service: EnvironmentWorkspaceServiceSource | null;
  readonly hostAuthorityChannels: readonly EnvironmentHostAuthorityChannel[];
  readonly platformDetails: readonly EnvironmentWorkspacePlatformDetail[];
}

export interface EnvironmentWorkspacePlatformDetail {
  readonly label: string;
  readonly value: string;
}

export interface EnvironmentWorkspaceField {
  readonly label: string;
  readonly value: string;
  readonly source: "client" | "server" | "host";
  readonly readOnly: boolean;
  readonly help?: string;
}

export interface EnvironmentWorkspaceSection {
  readonly title: string;
  readonly description: string;
  readonly fields: readonly EnvironmentWorkspaceField[];
}

export interface EnvironmentWorkspaceBanner {
  readonly kind: "offline" | "warning" | "updating";
  readonly title: string;
  readonly description: string;
  readonly readOnly: boolean;
}

export interface EnvironmentWorkspaceModel {
  readonly environmentId: string;
  readonly displayLabel: string;
  readonly canonicalLabel: string;
  readonly status: EnvironmentWorkspaceStatus;
  readonly banner: EnvironmentWorkspaceBanner | null;
  readonly clientPreferences: {
    readonly aliasEditable: true;
    readonly orderEditable: true;
    readonly pinEditable: true;
  };
  readonly hostControls: { readonly enabled: boolean; readonly reason: string | null };
  readonly sections: Record<EnvironmentWorkspaceTab, EnvironmentWorkspaceSection>;
}

function humanize(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .replaceAll("-", " ")
    .replace(/^./u, (character) => character.toUpperCase());
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
}

function workspaceBanner(source: EnvironmentWorkspaceSource): EnvironmentWorkspaceBanner | null {
  if (source.status === "online") return null;
  if (source.status === "updating") {
    return {
      kind: "updating",
      title: "Server update in progress",
      description:
        "Cached data remains readable. Mutations resume after identity is verified again.",
      readOnly: true,
    };
  }
  if (source.status === "offline" || source.status === "stopped") {
    const synchronized =
      source.lastSynchronizedAt === null
        ? "no cached synchronization"
        : `last synchronized ${formatTimestamp(source.lastSynchronizedAt)}`;
    return {
      kind: "offline",
      title: `${source.status === "stopped" ? "Stopped" : "Offline"} · ${synchronized}`,
      description: source.hasCachedContent
        ? "Cached server data is read-only. Reconnect before making changes; mutations are never queued."
        : "Content unavailable offline. Reconnect to load server data; mutations are never queued.",
      readOnly: true,
    };
  }
  return {
    kind: "warning",
    title: humanize(source.status),
    description:
      source.status === "authentication-required"
        ? "Pair this client again to restore administrator access."
        : source.status === "version-incompatible"
          ? "Update the client or server before making changes."
          : source.status === "setup-required"
            ? "Review and approve server setup from Add Environment."
            : "Connection verification is still in progress; cached server data is read-only.",
    readOnly: true,
  };
}

function field(
  label: string,
  value: string | number | null,
  source: EnvironmentWorkspaceField["source"],
  readOnly: boolean,
  help?: string,
): EnvironmentWorkspaceField {
  return {
    label,
    value: value === null || value === "" ? "Not reported" : String(value),
    source,
    readOnly,
    ...(help === undefined ? {} : { help }),
  };
}

function routeFields(
  source: EnvironmentWorkspaceSource,
  serverReadOnly: boolean,
): readonly EnvironmentWorkspaceField[] {
  if (source.routes.length === 0) {
    return [field("Routes", "No verified route metadata", "client", false)];
  }
  return source.routes.flatMap((route, index) => [
    field(`Route ${index + 1}`, `${route.label} · ${route.address}`, "client", false),
    field(
      `Route ${index + 1} policy`,
      `${route.pinned ? "Pinned" : "Automatic"} · ${route.autoconnect ? "Autoconnect" : "Manual"} · priority ${route.priority}`,
      "client",
      false,
    ),
    field(
      `Route ${index + 1} trust`,
      route.trust,
      "server",
      serverReadOnly,
      route.kind === "https"
        ? "Direct HTTPS uses operating-system certificate trust or an explicit SPKI SHA-256 pin."
        : undefined,
    ),
  ]);
}

function serviceFields(
  source: EnvironmentWorkspaceSource,
  hostControlsEnabled: boolean,
): readonly EnvironmentWorkspaceField[] {
  const service = source.service;
  if (service === null) {
    return [field("Service state", "Not reported by this server version", "server", true)];
  }
  return [
    field("Mode", service.mode, "host", !hostControlsEnabled),
    field("Startup", humanize(service.startupMechanism), "host", !hostControlsEnabled),
    field("Runtime state", humanize(service.runtimeState), "host", !hostControlsEnabled),
    field("Service account", service.account, "host", !hostControlsEnabled),
    field("Binary path", service.binaryPath, "host", !hostControlsEnabled),
    field("Data path", service.dataPath, "host", !hostControlsEnabled),
    field("Bind", service.bind, "host", !hostControlsEnabled),
  ];
}

export function createEnvironmentWorkspaceModel(
  source: EnvironmentWorkspaceSource,
): EnvironmentWorkspaceModel {
  const serverReadOnly = source.status !== "online";
  const hostControlsEnabled =
    !serverReadOnly && source.hostAuthorityChannels.length > 0 && source.service !== null;
  const capabilities = Object.entries(source.capabilities)
    .filter(([, value]) => value !== false && value !== null)
    .map(([name]) => humanize(name))
    .join(", ");
  const activeRoute =
    source.routes.find((route) => route.routeId === source.activeRouteId)?.label ??
    (source.activeRouteId === null ? "None verified" : source.activeRouteId);
  const service = source.service;

  return {
    environmentId: source.environmentId,
    displayLabel: source.alias ?? source.canonicalLabel,
    canonicalLabel: source.canonicalLabel,
    status: source.status,
    banner: workspaceBanner(source),
    clientPreferences: {
      aliasEditable: true,
      orderEditable: true,
      pinEditable: true,
    },
    hostControls: {
      enabled: hostControlsEnabled,
      reason: hostControlsEnabled
        ? null
        : serverReadOnly
          ? "Reconnect this environment before changing its host service. Host controls are never queued."
          : "Host controls require the desktop bridge, local control channel, or an SSH administrator path.",
    },
    sections: {
      overview: {
        title: "Overview",
        description: "Identity, compatibility, and ownership for this environment.",
        fields: [
          field("Client alias", source.alias, "client", false),
          field("Canonical label", source.canonicalLabel, "server", serverReadOnly),
          field("Environment UUID", source.environmentId, "server", serverReadOnly),
          field("Storage UUID", source.acceptedStorageInstanceId, "server", serverReadOnly),
          field(
            "Platform",
            `${source.platform.os} · ${source.platform.arch}`,
            "server",
            serverReadOnly,
          ),
          field("Server version", source.serverVersion, "server", serverReadOnly),
          field(
            "Protocol range",
            `${source.protocol.minimum}–${source.protocol.maximum}`,
            "server",
            serverReadOnly,
          ),
          field("Capabilities", capabilities || "None reported", "server", serverReadOnly),
          field("Projects", source.projectCount, "server", serverReadOnly),
          field("Threads", source.threadCount, "server", serverReadOnly),
          field("Active route", activeRoute, "server", serverReadOnly),
        ],
      },
      connection: {
        title: "Connection",
        description: "Ordered verified routes, local policy, identity, and trust.",
        fields: routeFields(source, serverReadOnly),
      },
      service: {
        title: "Service",
        description: "Server runtime and host-owned service controls.",
        fields: serviceFields(source, hostControlsEnabled),
      },
      security: {
        title: "Security",
        description: "Paired clients use Full administrator access in this release.",
        fields: [
          field("Client access", "Full administrator", "server", serverReadOnly),
          field(
            "Transport trust",
            source.routes.map((route) => route.trust).join(", "),
            "server",
            serverReadOnly,
          ),
          ...(source.pairedClients.length === 0
            ? [field("Paired clients", "No live client list available", "server", true)]
            : source.pairedClients.flatMap((client, index) => [
                field(
                  `Client ${index + 1}`,
                  `${client.label}${client.current ? " · This client" : ""} · ${client.platform}`,
                  "server",
                  serverReadOnly,
                ),
                field(
                  `Client ${index + 1} DPoP fingerprint`,
                  client.dpopFingerprint,
                  "server",
                  serverReadOnly,
                ),
                field(
                  `Client ${index + 1} activity`,
                  `Issued ${client.issuedAt} · ${client.lastConnectedAt === null ? "Never connected" : `Last connected ${client.lastConnectedAt}`}`,
                  "server",
                  serverReadOnly,
                ),
              ])),
        ],
      },
      projects: {
        title: "Projects & Storage",
        description: "Environment-owned projects, worktrees, and durable storage identity.",
        fields: [
          field("Projects", source.projectCount, "server", serverReadOnly),
          field("Workspace threads", source.threadCount, "server", serverReadOnly),
          field("Storage UUID", source.acceptedStorageInstanceId, "server", serverReadOnly),
          ...source.projects.map((project, index) =>
            field(
              `Project ${index + 1}`,
              `${project.title} · ${project.workspaceRoot}`,
              "server",
              serverReadOnly,
            ),
          ),
          field("Data path", service?.dataPath ?? null, "host", !hostControlsEnabled),
          field("Backup health", "Not reported", "server", true),
        ],
      },
      updates: {
        title: "Updates",
        description: "Compatible server updates and rollback state.",
        fields: [
          field(
            "Installed version",
            service?.version ?? source.serverVersion,
            "server",
            serverReadOnly,
          ),
          field("Channel", "Stable", "server", serverReadOnly),
          field("Update state", service?.updatePhase ?? "Not reported", "server", serverReadOnly),
          field(
            "Binary rollback",
            "Preserve previous verified version",
            "host",
            !hostControlsEnabled,
          ),
        ],
      },
      diagnostics: {
        title: "Diagnostics",
        description: "Bounded local diagnostics with explicit export only.",
        fields: [
          field("Collection", "Local and redacted", "server", serverReadOnly),
          field(
            "Privacy",
            "No upload, analytics, crash reporting, or usage reporting",
            "client",
            false,
          ),
          field("Export", "Explicit user action only", "client", false),
        ],
      },
      platform: {
        title: "Platform",
        description: "Platform-owned runtime and service details.",
        fields: [
          field("Operating system", source.platform.os, "server", serverReadOnly),
          field("Architecture", source.platform.arch, "server", serverReadOnly),
          ...source.platformDetails.map((detail) =>
            field(detail.label, detail.value, "host", !hostControlsEnabled),
          ),
        ],
      },
    },
  };
}
