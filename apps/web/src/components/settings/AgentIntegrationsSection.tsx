import type { EnvironmentId } from "@bibcode/contracts";
import {
  DEFAULT_MCP_SERVER_ACCESS,
  DEFAULT_SERVER_SETTINGS,
  type McpCapabilities,
  type McpCapabilitiesPatch,
  type McpServerAccess,
  type UnifiedSettings,
} from "@bibcode/contracts/settings";
import {
  agentRegistrationCommand,
  joinCommand,
  type LaunchShell,
} from "@bibcode/shared/launchCommand";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@bibcode/client-runtime/state/runtime";
import { CheckIcon, CopyIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";
import { useId, useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import type { EnvironmentPresentation } from "../../state/environments";
import { usePrimaryAgentAccess, usePrimaryMcpClients } from "../../state/mcpActivity";
import { isFailingEndpoint, useWebhookList } from "../../state/webhooks";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Tabs, TabsList, TabsPanel, TabsTab } from "../ui/tabs";
import { DiagnosticsEnvironmentSelect, useDiagnosticsEnvironment } from "./diagnosticsEnvironment";
import { McpAgentsPanel } from "./McpAgentsPanel";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { WebhooksTab } from "./WebhooksTab";

const SERVER_TITLE = "MCP server";
const SERVER_DESCRIPTION =
  "Let AI tools operate this environment: threads, worktrees, Git and pull requests.";
const ACCESS_TITLE = "Agents may";
const ACCESS_DESCRIPTION =
  "Threads an MCP agent starts or messages never run with more access than this. At any level above Read only, agents can also answer approvals, remove worktrees, discard changes, force-push and merge pull requests. If you raise it, agents already connected keep their old limit until their MCP server restarts.";
const CAPABILITIES_TITLE = "What agents can use";
const CAPABILITIES_DESCRIPTION =
  "Turn whole sets of tools on or off for MCP agents. A change applies to their next call.";
const OLDER_SERVER_MESSAGE = "Update this server to use outside agents.";
const SERVER_OFF_MESSAGE = "Turn on MCP server first.";
const FULL_ACCESS_FIRST_MESSAGE = "Set Agents may to Full access first.";

/** The `mcpCapabilities` sets, in the order Settings lists them. */
const MCP_CAPABILITY_OPTIONS: ReadonlyArray<{
  readonly key: keyof McpCapabilities;
  readonly label: string;
  readonly description: string;
}> = [
  {
    key: "workspace",
    label: "Threads and worktrees",
    description: "Threads, approvals, worktrees, and the browser and device previews.",
  },
  {
    key: "sourceControl",
    label: "Source Control and pull requests",
    description: "Git status, commits, branches, pushes and pull requests.",
  },
  { key: "files", label: "Files", description: "Read and change files in a thread's folder." },
  {
    key: "diagnostics",
    label: "Diagnostics",
    description: "The profiler's findings and BiBCode's processes.",
  },
  {
    key: "terminals",
    label: "Terminals",
    description:
      "Let MCP agents open terminals and run any command in this environment. Agents pick this up only after their MCP server restarts, or after a remote agent reauthorizes.",
  },
];

const DEFAULT_CAPABILITIES = DEFAULT_SERVER_SETTINGS.mcpCapabilities;

/** The composer's labels for the runtime modes, and Read only for no operate tools at all. */
export const MCP_ACCESS_OPTIONS: ReadonlyArray<{
  readonly value: McpServerAccess;
  readonly label: string;
}> = [
  { value: "read-only", label: "Read only" },
  { value: "approval-required", label: "Supervised" },
  { value: "auto-accept-edits", label: "Auto-accept edits" },
  { value: "full-access", label: "Full access" },
];

const selectEnabled = (settings: UnifiedSettings) => settings.enableMcpServer;
const selectWebhooksEnabled = (settings: UnifiedSettings) => settings.enableWebhooks;
const selectAccess = (settings: UnifiedSettings) => settings.mcpServerAccess;
const selectCapabilities = (settings: UnifiedSettings) => settings.mcpCapabilities;

type McpSettingsPatch = {
  enableMcpServer?: boolean;
  mcpServerAccess?: McpServerAccess;
  mcpCapabilities?: McpCapabilitiesPatch;
};

const sameCapabilities = (left: McpCapabilities, right: McpCapabilities) =>
  MCP_CAPABILITY_OPTIONS.every(({ key }) => left[key] === right[key]);

/**
 * The shell the copied command runs in: the server's own host, whose executable path says
 * which one it is.
 */
export function launchShellFor(argv: ReadonlyArray<string>): LaunchShell {
  const executable = argv[0] ?? "";
  return WINDOWS_PATH.test(executable) || executable.startsWith("\\\\") ? "windows" : "posix";
}

const WINDOWS_PATH = /^[A-Za-z]:[\\/]/;

type IntegrationsTab = "mcp" | "webhooks";

/**
 * Settings → Agents → Agent integrations of the chosen environment: its MCP server and its
 * outbound webhooks, one tab each, under a status line that summarizes both.
 */
export function AgentIntegrationsSection() {
  // Kept here: unlike the Diagnostics page, no link chooses this section's environment.
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(null);
  const [tab, setTab] = useState<IntegrationsTab>("mcp");
  const { environments, connected, primaryEnvironment, environment, waitingFor } =
    useDiagnosticsEnvironment(selectedEnvironmentId, setSelectedEnvironmentId);
  if (environment === null) return null;
  const isPrimary = environment.environmentId === primaryEnvironment?.environmentId;
  const supported =
    environment.serverConfig !== null && environment.serverConfig.mcpLaunch !== undefined;
  return (
    <SettingsSection
      title="Agent integrations"
      headerAction={
        <IntegrationsStatus
          key={environment.environmentId}
          environmentId={environment.environmentId}
          isPrimary={isPrimary}
          supported={supported}
        />
      }
    >
      {connected.length > 1 || waitingFor !== undefined ? (
        <SettingsRow
          title="Environment"
          description="Choose which environment outside agents operate. Each environment has its own MCP server."
          status={
            waitingFor === undefined
              ? null
              : `${waitingFor.label} is not connected. Showing ${environment.label}.`
          }
          control={
            <DiagnosticsEnvironmentSelect
              environments={environments}
              value={waitingFor ?? environment}
              onSelectEnvironment={setSelectedEnvironmentId}
            />
          }
        />
      ) : null}
      <Tabs
        value={tab}
        onValueChange={(next) => setTab(next === "webhooks" ? "webhooks" : "mcp")}
        className="gap-0"
      >
        <div className="border-t border-border/60 px-4 py-3 first:border-t-0 sm:px-5">
          <TabsList aria-label="Agent integrations">
            <TabsTab value="mcp">MCP</TabsTab>
            <TabsTab value="webhooks">Webhooks</TabsTab>
          </TabsList>
        </div>
        <TabsPanel value="mcp" className="gap-0">
          <EnvironmentMcpServer
            key={environment.environmentId}
            environment={environment}
            isPrimary={isPrimary}
          />
          {isPrimary ? <McpAgentsPanel /> : null}
          {isPrimary ? <RevokedPairingNotice environmentId={environment.environmentId} /> : null}
        </TabsPanel>
        <TabsPanel value="webhooks" className="gap-0">
          <WebhooksTab
            key={environment.environmentId}
            environmentId={environment.environmentId}
            isPrimary={isPrimary}
            supported={supported}
          />
        </TabsPanel>
      </Tabs>
    </SettingsSection>
  );
}

/** Webhook endpoints a revoked agent's pairing turned off, named in the MCP tab too. */
function RevokedPairingNotice({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const access = usePrimaryAgentAccess();
  const webhooks = useWebhookList(access.canRead ? environmentId : null);
  const names = (webhooks.data?.endpoints ?? [])
    .filter((endpoint) => endpoint.disabledReason === "client-revoked")
    .map((endpoint) => endpoint.name);
  if (names.length === 0) return null;
  return (
    <SettingsRow
      title="Webhooks turned off"
      description={`Revoking their paired MCP client turned off ${names.join(", ")}. Re-enable them in the Webhooks tab.`}
    />
  );
}

/**
 * The section header's summary: MCP on or off, the agents connected (known for the primary
 * environment, whose access this app manages), and the webhook endpoints active and failing.
 */
function IntegrationsStatus({
  environmentId,
  isPrimary,
  supported,
}: {
  readonly environmentId: EnvironmentId;
  readonly isPrimary: boolean;
  readonly supported: boolean;
}) {
  const mcpEnabled = useEnvironmentSettings(environmentId, selectEnabled);
  const webhooksEnabled = useEnvironmentSettings(environmentId, selectWebhooksEnabled);
  const clients = usePrimaryMcpClients();
  const access = usePrimaryAgentAccess();
  // Only where this app knows the session may read them (the primary environment's
  // `access:read`): elsewhere the Webhooks tab reads them when opened.
  const webhooks = useWebhookList(supported && isPrimary && access.canRead ? environmentId : null);
  if (!supported) return null;
  const parts = [mcpEnabled ? "MCP on" : "MCP off"];
  if (isPrimary) {
    const connected = clients.filter((client) => client.connected).length;
    parts.push(`${connected} ${connected === 1 ? "agent" : "agents"} connected`);
  }
  const endpoints = webhooks.data?.endpoints;
  if (!webhooksEnabled) {
    parts.push("Webhooks off");
  } else if (endpoints !== undefined) {
    let failing = 0;
    let active = 0;
    for (const endpoint of endpoints) {
      if (isFailingEndpoint(endpoint)) failing += 1;
      else if (endpoint.enabled) active += 1;
    }
    parts.push(
      failing > 0
        ? `${active} ${active === 1 ? "webhook" : "webhooks"} active, ${failing} failing`
        : `${active} ${active === 1 ? "webhook" : "webhooks"} active`,
    );
  }
  return (
    <p role="status" className="truncate text-xs text-muted-foreground" title={parts.join(" · ")}>
      {parts.join(" · ")}
    </p>
  );
}

function EnvironmentMcpServer({
  environment,
  isPrimary,
}: {
  readonly environment: EnvironmentPresentation;
  readonly isPrimary: boolean;
}) {
  const environmentId = environment.environmentId;
  const enabled = useEnvironmentSettings(environmentId, selectEnabled);
  const access = useEnvironmentSettings(environmentId, selectAccess);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const serverReasonId = useId();
  const accessReasonId = useId();
  const serverConfig = environment.serverConfig;
  // A server older than MCP support reports no launch command at all.
  const supported = serverConfig !== null && serverConfig.mcpLaunch !== undefined;
  const connecting = serverConfig === null;
  const label = environment.label.trim() || "this server";

  const serverReason = connecting
    ? `Connecting to ${label}…`
    : supported
      ? null
      : OLDER_SERVER_MESSAGE;
  const accessReason = serverReason ?? (enabled ? null : SERVER_OFF_MESSAGE);
  const accessLabel = MCP_ACCESS_OPTIONS.find((option) => option.value === access)?.label ?? access;
  const [saveError, setSaveError] = useState<string | null>(null);
  const save = async (patch: McpSettingsPatch) => {
    setSaveError(null);
    // A `ServerSettingsPatch`: the server merges a subset of `mcpCapabilities`, so a switch
    // never overwrites another set's key. The updater is typed with whole values.
    const result = await updateSettings(patch as Partial<UnifiedSettings>);
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    const detail =
      failure instanceof Error && failure.message.trim().length > 0
        ? failure.message
        : `Check the connection to ${label}.`;
    setSaveError(`Could not save the MCP server setting. ${detail} Try again.`);
  };

  return (
    <>
      <SettingsRow
        title={SERVER_TITLE}
        description={SERVER_DESCRIPTION}
        resetAction={
          supported && !enabled ? (
            <SettingResetButton
              label="MCP server"
              onClick={() => void save({ enableMcpServer: true })}
            />
          ) : null
        }
        status={
          saveError !== null ? (
            <div role="alert" className="flex items-start gap-1.5 text-destructive">
              <TriangleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <span>{saveError}</span>
            </div>
          ) : serverReason === null ? null : (
            <ReasonLine id={serverReasonId} text={serverReason} />
          )
        }
        control={
          <Switch
            checked={supported && enabled}
            disabled={!supported}
            onCheckedChange={(checked) => void save({ enableMcpServer: checked })}
            aria-label={SERVER_TITLE}
            aria-describedby={serverReason === null ? undefined : serverReasonId}
          />
        }
      />
      <SettingsRow
        title={ACCESS_TITLE}
        description={ACCESS_DESCRIPTION}
        resetAction={
          supported && access !== DEFAULT_MCP_SERVER_ACCESS ? (
            <SettingResetButton
              label="agent access"
              onClick={() => void save({ mcpServerAccess: DEFAULT_MCP_SERVER_ACCESS })}
            />
          ) : null
        }
        status={
          accessReason === null || accessReason === serverReason ? null : (
            <ReasonLine id={accessReasonId} text={accessReason} />
          )
        }
        control={
          <Select
            value={access}
            disabled={accessReason !== null}
            onValueChange={(next) => {
              const option = MCP_ACCESS_OPTIONS.find((candidate) => candidate.value === next);
              if (option !== undefined) void save({ mcpServerAccess: option.value });
            }}
          >
            <SelectTrigger
              aria-label={ACCESS_TITLE}
              aria-describedby={
                accessReason === null
                  ? undefined
                  : accessReason === serverReason
                    ? serverReasonId
                    : accessReasonId
              }
              className="w-full sm:w-48"
            >
              <SelectValue>{accessLabel}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {MCP_ACCESS_OPTIONS.map((option) => (
                <SelectItem hideIndicator key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <CapabilitiesRow
        environmentId={environmentId}
        reason={accessReason}
        reasonId={accessReason === serverReason ? serverReasonId : accessReasonId}
        fullAccess={access === "full-access"}
        resettable={supported}
        onChange={(patch) => void save({ mcpCapabilities: patch })}
      />
      {supported && serverConfig?.mcpLaunch ? (
        <LaunchCommandRow argv={serverConfig.mcpLaunch.argv} isPrimary={isPrimary} label={label} />
      ) : null}
    </>
  );
}

/**
 * Agents may → What agents can use: one switch per `mcpCapabilities` set. Each switch writes
 * only its own key and applies live, so none asks first.
 */
function CapabilitiesRow({
  environmentId,
  reason,
  reasonId,
  fullAccess,
  resettable,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  /** Why every switch is disabled, shown on a row above under `reasonId`; `null` when not. */
  readonly reason: string | null;
  readonly reasonId: string;
  readonly fullAccess: boolean;
  readonly resettable: boolean;
  readonly onChange: (patch: McpCapabilitiesPatch) => void;
}) {
  const capabilities = useEnvironmentSettings(environmentId, selectCapabilities);
  const terminalsReasonId = useId();
  return (
    <SettingsRow
      title={CAPABILITIES_TITLE}
      description={CAPABILITIES_DESCRIPTION}
      resetAction={
        resettable && !sameCapabilities(capabilities, DEFAULT_CAPABILITIES) ? (
          <SettingResetButton
            label="agent capabilities"
            onClick={() => onChange(DEFAULT_CAPABILITIES)}
          />
        ) : null
      }
    >
      <ul className="divide-y divide-border/60 pb-1">
        {MCP_CAPABILITY_OPTIONS.map((option) => {
          const ownReason =
            reason === null && option.key === "terminals" && !fullAccess
              ? FULL_ACCESS_FIRST_MESSAGE
              : null;
          const describedBy =
            reason !== null ? reasonId : ownReason !== null ? terminalsReasonId : undefined;
          return (
            <li
              key={option.key}
              className="flex items-center justify-between gap-3 py-2.5 first:pt-3"
            >
              <div className="min-w-0 space-y-0.5">
                <div className="text-[13px] font-medium text-foreground">{option.label}</div>
                <p className="text-xs text-muted-foreground">{option.description}</p>
                {ownReason === null ? null : (
                  <div className="pt-0.5 text-xs text-muted-foreground">
                    <ReasonLine id={terminalsReasonId} text={ownReason} />
                  </div>
                )}
              </div>
              <Switch
                checked={capabilities[option.key]}
                disabled={reason !== null || ownReason !== null}
                onCheckedChange={(checked) => onChange({ [option.key]: checked })}
                aria-label={option.label}
                aria-describedby={describedBy}
              />
            </li>
          );
        })}
      </ul>
    </SettingsRow>
  );
}

function ReasonLine({ id, text }: { readonly id: string; readonly text: string }) {
  return (
    <div id={id} className="flex items-start gap-1.5">
      <InfoIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span>{text}</span>
    </div>
  );
}

function LaunchCommandRow({
  argv,
  isPrimary,
  label,
}: {
  readonly argv: ReadonlyArray<string>;
  readonly isPrimary: boolean;
  readonly label: string;
}) {
  const command = joinCommand(argv, launchShellFor(argv));
  const copies = [
    { key: "command", label: "Copy", text: command },
    {
      key: "claude",
      label: "Copy for Claude Code",
      text: agentRegistrationCommand("claude", command),
    },
    { key: "codex", label: "Copy for Codex", text: agentRegistrationCommand("codex", command) },
  ] as const;
  return (
    <SettingsRow
      title="Launch command"
      description={
        isPrimary
          ? "Add this to your agent as an MCP server. It runs on this computer and needs BiBCode running."
          : `Run this on ${label}'s host, or over SSH from here (ssh <host> -- followed by the command). It needs that server running.`
      }
    >
      <div className="space-y-2 pt-2.5 pb-3.5">
        <code
          aria-label="Launch command"
          className="block overflow-x-auto rounded-md bg-muted px-2.5 py-2 font-mono text-xs break-all whitespace-pre-wrap text-foreground"
        >
          {command}
        </code>
        <div className="flex flex-wrap gap-2">
          {copies.map((copy) => (
            <CopyCommandButton key={copy.key} label={copy.label} text={copy.text} />
          ))}
        </div>
      </div>
    </SettingsRow>
  );
}

function CopyCommandButton({ label, text }: { readonly label: string; readonly text: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  return (
    <Button size="xs" variant="outline" onClick={() => copyToClipboard(text, undefined)}>
      {isCopied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      {isCopied ? "Copied" : label}
    </Button>
  );
}
