import type { EnvironmentId } from "@bibcode/contracts";
import {
  DEFAULT_MCP_SERVER_ACCESS,
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
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { DiagnosticsEnvironmentSelect, useDiagnosticsEnvironment } from "./diagnosticsEnvironment";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

const SERVER_TITLE = "MCP server";
const SERVER_DESCRIPTION =
  "Let AI tools on this computer, or over SSH, operate this environment's threads.";
const ACCESS_TITLE = "Agents may";
const ACCESS_DESCRIPTION =
  "Threads an MCP agent starts or messages never run with more access than this. If you raise it, agents already connected keep their old limit until their MCP server restarts.";
const OLDER_SERVER_MESSAGE = "Update this server to use outside agents.";
const SERVER_OFF_MESSAGE = "Turn on MCP server first.";

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
const selectAccess = (settings: UnifiedSettings) => settings.mcpServerAccess;

/**
 * The shell the copied command runs in: the server's own host, whose executable path says
 * which one it is.
 */
export function launchShellFor(argv: ReadonlyArray<string>): LaunchShell {
  const executable = argv[0] ?? "";
  return WINDOWS_PATH.test(executable) || executable.startsWith("\\\\") ? "windows" : "posix";
}

const WINDOWS_PATH = /^[A-Za-z]:[\\/]/;

/** Settings → Agents → Agent integrations: the MCP server of the chosen environment. */
export function AgentIntegrationsSection() {
  // Kept here: unlike the Diagnostics page, no link chooses this section's environment.
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(null);
  const { environments, connected, primaryEnvironment, environment, waitingFor } =
    useDiagnosticsEnvironment(selectedEnvironmentId, setSelectedEnvironmentId);
  if (environment === null) return null;
  return (
    <SettingsSection title="Agent integrations">
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
      <EnvironmentMcpServer
        key={environment.environmentId}
        environment={environment}
        isPrimary={environment.environmentId === primaryEnvironment?.environmentId}
      />
    </SettingsSection>
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
  const save = async (patch: { enableMcpServer?: boolean; mcpServerAccess?: McpServerAccess }) => {
    setSaveError(null);
    const result = await updateSettings(patch);
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
      {supported && serverConfig?.mcpLaunch ? (
        <LaunchCommandRow argv={serverConfig.mcpLaunch.argv} isPrimary={isPrimary} label={label} />
      ) : null}
    </>
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
