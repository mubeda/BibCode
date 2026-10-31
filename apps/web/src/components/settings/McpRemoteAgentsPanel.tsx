import type {
  AuthMcpAccessLevel,
  AuthPendingMcpAuthorization,
  EnvironmentId,
} from "@bibcode/contracts";
import type { McpServerAccess, UnifiedSettings } from "@bibcode/contracts/settings";
import { CheckIcon, CopyIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";
import { useId, useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironmentHttpBaseUrl } from "../../state/environments";
import {
  approveMcpAuthorization,
  denyMcpAuthorization,
  remoteMcpUrl,
  requestedScopeText,
  usePrimaryMcpAuthorizations,
} from "../../state/mcpAuthorizations";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./settingsLayout";

/** The element **Review** on a request's toast scrolls to. */
export const REQUESTS_TO_CONNECT_ID = "mcp-requests-to-connect";

const NO_HTTPS_MESSAGE =
  "Remote agents need an HTTPS address. Use the launch command over SSH instead.";
const SERVER_OFF_MESSAGE = "Turn on MCP server first.";
const FULL_ACCESS_FIRST_MESSAGE = "Set Agents may to Full access first.";
const LOOPBACK_WARNING = "Only approve if you just started this in an AI tool on that computer.";

/** The levels a person may approve at, lowest first, with the composer's labels. */
const ACCESS_OPTIONS: ReadonlyArray<{ readonly value: McpServerAccess; readonly label: string }> = [
  { value: "read-only", label: "Read only" },
  { value: "approval-required", label: "Supervised" },
  { value: "auto-accept-edits", label: "Auto-accept edits" },
  { value: "full-access", label: "Full access" },
];

const selectEnabled = (settings: UnifiedSettings) => settings.enableMcpServer;
const selectAccess = (settings: UnifiedSettings) => settings.mcpServerAccess;
const selectTerminals = (settings: UnifiedSettings) => settings.mcpCapabilities.terminals;

/** The levels at or below the environment's Agents may. */
export function approvableLevels(ceiling: McpServerAccess) {
  const index = ACCESS_OPTIONS.findIndex((option) => option.value === ceiling);
  return ACCESS_OPTIONS.slice(0, index < 0 ? 1 : index + 1);
}

/**
 * Settings → Agents → Agent integrations → MCP (#139, slice R): the **Remote agents** row with
 * the MCP URL and the commands that connect Claude Code and Codex to it over HTTPS, and the
 * **Requests to connect** that wait for a person's approval. Requests are decided where this
 * app manages access, as Authorized clients and Agents are.
 */
export function McpRemoteAgentsPanel({
  environmentId,
  isPrimary,
}: {
  readonly environmentId: EnvironmentId;
  readonly isPrimary: boolean;
}) {
  return (
    <>
      <RemoteAgentsRow environmentId={environmentId} />
      {isPrimary ? <RequestsToConnect environmentId={environmentId} /> : null}
    </>
  );
}

function RemoteAgentsRow({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const url = remoteMcpUrl(useEnvironmentHttpBaseUrl(environmentId));
  const enabled = useEnvironmentSettings(environmentId, selectEnabled);
  if (url === null) {
    return <SettingsRow title="Remote agents" description={NO_HTTPS_MESSAGE} />;
  }
  return (
    <SettingsRow
      title="Remote agents"
      description="AI tools on other computers connect to this address over HTTPS and sign in. You approve each sign-in here."
      status={enabled ? null : <Reason text={SERVER_OFF_MESSAGE} />}
    >
      <div className="space-y-2 pt-2.5 pb-3.5">
        <code
          aria-label="Remote MCP URL"
          className="block overflow-x-auto rounded-md bg-muted px-2.5 py-2 font-mono text-xs break-all whitespace-pre-wrap text-foreground"
        >
          {url}
        </code>
        <div className="flex flex-wrap gap-2">
          <CopyButton
            label="Copy for Claude Code"
            text={`claude mcp add --transport http bibcode ${url}`}
          />
          <CopyButton label="Copy for Codex" text={`codex mcp add bibcode --url ${url}`} />
        </div>
      </div>
    </SettingsRow>
  );
}

function RequestsToConnect({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { requests, canManage } = usePrimaryMcpAuthorizations();
  const ceiling = useEnvironmentSettings(environmentId, selectAccess);
  const terminalsOn = useEnvironmentSettings(environmentId, selectTerminals);
  if (requests.length === 0) return null;
  return (
    <SettingsRow
      id={REQUESTS_TO_CONNECT_ID}
      title="Requests to connect"
      description="AI tools waiting for your approval. Approve only a request you started, after checking that its code matches the one its sign-in page shows."
    >
      <ul className="divide-y divide-border/60 pb-1" aria-label="Requests to connect">
        {requests.map((request) => (
          <RequestCard
            key={request.id}
            request={request}
            ceiling={ceiling}
            terminalsOn={terminalsOn}
            canManage={canManage}
          />
        ))}
      </ul>
    </SettingsRow>
  );
}

function RequestCard({
  request,
  ceiling,
  terminalsOn,
  canManage,
}: {
  readonly request: AuthPendingMcpAuthorization;
  readonly ceiling: McpServerAccess;
  readonly terminalsOn: boolean;
  readonly canManage: boolean;
}) {
  const levels = approvableLevels(ceiling);
  const [chosen, setChosen] = useState<AuthMcpAccessLevel | null>(null);
  // Defaults to, and is capped at, the environment's level as it is now.
  const access =
    chosen !== null && levels.some((level) => level.value === chosen) ? chosen : ceiling;
  const [terminals, setTerminals] = useState(false);
  const [pending, setPending] = useState<"approve" | "deny" | null>(null);
  const busy = pending !== null;
  const [failure, setFailure] = useState<string | null>(null);
  const terminalsReasonId = useId();
  const askedForTerminals = request.scopes.includes("terminal:operate");
  const showTerminals = askedForTerminals && terminalsOn && ceiling === "full-access";
  const terminalsAllowed = showTerminals && access === "full-access";
  const name = request.clientName.trim() || "An AI tool";
  // A decided card stays disabled until the access stream removes it, so it is never sent
  // twice; a failure leaves it usable.
  const decide = async (
    kind: "approve" | "deny",
    decision: () => Promise<void>,
    failed: string,
  ) => {
    setPending(kind);
    setFailure(null);
    try {
      await decision();
    } catch {
      setFailure(
        `${failed} The request may have expired or been decided elsewhere. Check the connection and the AI tool, then try again.`,
      );
      setPending(null);
    }
  };
  const manageReason = canManage ? undefined : "Deciding needs an administrator session here.";
  return (
    <li className="space-y-2.5 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="min-w-0 truncate text-[13px] font-medium text-foreground">{name}</div>
        <div className="text-xs text-muted-foreground">
          Code{" "}
          <span className="font-mono text-sm font-semibold text-foreground">{request.code}</span>
        </div>
      </div>
      <div className="space-y-0.5 text-xs text-muted-foreground">
        <div>
          Returns to <span className="font-mono">{request.redirectHost}</span> · Asked through{" "}
          <span className="font-mono break-all">{request.origin}</span>
        </div>
        <div>{requestedScopeText(request.scopes)}</div>
      </div>
      {request.redirectIsLoopback ? (
        <div className="flex items-start gap-1.5 text-xs text-warning-foreground">
          <TriangleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>{LOOPBACK_WARNING}</span>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-2 text-xs text-foreground">
          Agents may
          <Select
            value={access}
            disabled={busy || !canManage}
            onValueChange={(next) => {
              const level = levels.find((option) => option.value === next);
              if (level !== undefined) setChosen(level.value);
            }}
          >
            <SelectTrigger aria-label={`Agents may, for ${name}`} className="w-40">
              <SelectValue>
                {levels.find((level) => level.value === access)?.label ?? access}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="start" alignItemWithTrigger={false}>
              {levels.map((level) => (
                <SelectItem hideIndicator key={level.value} value={level.value}>
                  {level.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </label>
        {showTerminals ? (
          <label className="flex items-center gap-2 text-xs text-foreground">
            <Checkbox
              checked={terminals && terminalsAllowed}
              disabled={busy || !canManage || !terminalsAllowed}
              aria-describedby={terminalsAllowed ? undefined : terminalsReasonId}
              onCheckedChange={(checked) => setTerminals(checked === true)}
            />
            Allow terminals
          </label>
        ) : null}
        <div className="ms-auto flex items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !canManage}
            title={manageReason}
            onClick={() =>
              void decide("deny", () => denyMcpAuthorization(request.id), "Not denied.")
            }
          >
            {pending === "deny" ? "Denying…" : "Deny"}
          </Button>
          <Button
            size="sm"
            disabled={busy || !canManage}
            title={manageReason}
            onClick={() =>
              void decide(
                "approve",
                () => approveMcpAuthorization(request.id, access, terminals && terminalsAllowed),
                "Not approved.",
              )
            }
          >
            {pending === "approve" ? "Approving…" : "Approve"}
          </Button>
        </div>
      </div>
      {showTerminals && !terminalsAllowed ? (
        <div className="text-xs text-muted-foreground">
          <Reason id={terminalsReasonId} text={FULL_ACCESS_FIRST_MESSAGE} />
        </div>
      ) : null}
      {failure !== null ? (
        <div role="alert" className="flex items-start gap-1.5 text-xs text-destructive">
          <TriangleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>{failure}</span>
        </div>
      ) : null}
    </li>
  );
}

function Reason({ id, text }: { readonly id?: string; readonly text: string }) {
  return (
    <div id={id} className="flex items-start gap-1.5">
      <InfoIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span>{text}</span>
    </div>
  );
}

function CopyButton({ label, text }: { readonly label: string; readonly text: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  return (
    <Button size="xs" variant="outline" onClick={() => copyToClipboard(text, undefined)}>
      {isCopied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      {isCopied ? "Copied" : label}
    </Button>
  );
}
