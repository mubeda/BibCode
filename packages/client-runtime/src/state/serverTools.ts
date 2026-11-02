import {
  ProviderDriverKind,
  ProviderInstanceId,
  TOOL_DISPLAY_NAMES,
  type ServerProvider,
  type ServerTool,
} from "@bibcode/contracts";

/**
 * A tool (CodeGraph) is not an agent provider, but its version notice, update progress and
 * result are the same as a provider's. The update surfaces (launch toast, sidebar pill,
 * environment rows, "Update all") read `ServerProvider`-shaped rows keyed by `driver` and
 * `instanceId`, so a tool enters them through this adapter and never reaches a provider list.
 */
export function isToolId(id: string): boolean {
  return Object.hasOwn(TOOL_DISPLAY_NAMES, id);
}

export function toolAsProvider(tool: ServerTool): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(tool.toolId),
    driver: ProviderDriverKind.make(tool.toolId),
    displayName: tool.displayName,
    enabled: tool.installed,
    installed: tool.installed,
    version: tool.version,
    status: "ready",
    auth: { status: "unknown" },
    checkedAt: tool.checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    agents: [],
    ...(tool.versionAdvisory === undefined ? {} : { versionAdvisory: tool.versionAdvisory }),
    ...(tool.updateState === undefined ? {} : { updateState: tool.updateState }),
  };
}

/**
 * The tools a server reports, as update rows. A server older than tool maintenance omits the
 * key, so it yields none and no update is ever sent to it.
 */
export function toolsAsProviders(
  tools: ReadonlyArray<ServerTool> | undefined,
): ReadonlyArray<ServerProvider> {
  return tools === undefined ? EMPTY : tools.map(toolAsProvider);
}

const EMPTY: ReadonlyArray<ServerProvider> = [];

/** What the update surfaces list for an environment: its providers, then its tools. */
export function updateSubjects(config: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly tools?: ReadonlyArray<ServerTool> | undefined;
}): ReadonlyArray<ServerProvider> {
  return config.tools === undefined || config.tools.length === 0
    ? config.providers
    : [...config.providers, ...toolsAsProviders(config.tools)];
}
