import {
  WEBHOOK_EVENT_CATEGORIES,
  type EnvironmentId,
  type WebhookDelivery,
  type WebhookEndpoint,
  type WebhookEventType,
} from "@bibcode/contracts";
import type { UnifiedSettings } from "@bibcode/contracts/settings";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@bibcode/client-runtime/state/runtime";
import { CheckIcon, CopyIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";
import { useId, useMemo, useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { useProjects } from "../../state/entities";
import { usePrimaryAgentAccess, usePrimaryMcpClients } from "../../state/mcpActivity";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { isFailingEndpoint, useWebhookList, webhooksEnvironment } from "../../state/webhooks";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";

const WEBHOOKS_TITLE = "Webhooks";
const WEBHOOKS_DESCRIPTION =
  "Send a signed HTTPS request to your endpoints when threads, approvals and agent operations change. Requests carry ids and states, never prompts, messages or file contents.";
const WEBHOOKS_OFF_MESSAGE = "Turn on Webhooks first.";
const DELIVERIES_SHOWN = 20;

const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  threads: "Threads",
  approvals: "Approvals",
  operations: "Agent operations",
  diagnostics: "Diagnostics",
};

const EVENT_LABELS: Readonly<Record<WebhookEventType, string>> = {
  "thread.status_changed": "Thread status changed",
  "worktree.created": "Worktree created",
  "panel.created": "Chat panel created",
  "approval.requested": "Approval requested",
  "approval.resolved": "Approval answered",
  "clone.completed": "Clone finished",
  "scm.operation_completed": "Git or pull request change",
  "transfer.completed": "File transfer finished",
  "transfer.failed": "File transfer failed",
  "profiler.finding": "Profiler finding",
};

const ALL_EVENTS: ReadonlyArray<WebhookEventType> = WEBHOOK_EVENT_CATEGORIES.flatMap(
  (category) => category.events,
);

const NO_PROJECT = "__none__";
/** A quick shape check; the server checks the URL fully, and its addresses when sending. */
const HTTPS_URL = /^https:\/\/[^\s/@]+/i;

const selectWebhooksEnabled = (settings: UnifiedSettings) => settings.enableWebhooks;

/** The message of a failed command, or `null` when it succeeded or was interrupted. */
function commandFailure(result: AtomCommandResult<unknown, unknown>, what: string): string | null {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
  const failure = squashAtomCommandFailure(result);
  const detail =
    failure instanceof Error && failure.message.trim().length > 0
      ? failure.message
      : typeof failure === "object" && failure !== null && "message" in failure
        ? String((failure as { message: unknown }).message)
        : "Check the connection and try again.";
  return `Could not ${what}. ${detail}`;
}

function timeText(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString(undefined, { dateStyle: "short", timeStyle: "medium" });
}

/** What an endpoint is doing, in a few words. */
export function endpointStatusText(endpoint: WebhookEndpoint): string {
  if (endpoint.disabledReason === "failures") return "Turned off after 10 failed deliveries";
  if (endpoint.disabledReason === "client-revoked") return "Turned off: its MCP client was revoked";
  if (!endpoint.enabled) return "Off";
  if (endpoint.consecutiveFailures > 0) {
    return `Failing: ${endpoint.consecutiveFailures} failed ${endpoint.consecutiveFailures === 1 ? "delivery" : "deliveries"} in a row`;
  }
  if (endpoint.pendingDeliveries > 0) return `On · ${endpoint.pendingDeliveries} queued`;
  return "On";
}

/** A delivery's outcome, in a few words. */
export function deliveryStatusText(delivery: WebhookDelivery): string {
  const status = delivery.lastStatus === null ? null : `HTTP ${delivery.lastStatus}`;
  switch (delivery.state) {
    case "delivered":
      return status ?? "Delivered";
    case "pending":
      return delivery.attempts === 0 ? "Queued" : `Retrying (${status ?? delivery.lastError})`;
    case "sending":
      return "Sending";
    case "abandoned":
      return "Not sent: webhooks or the endpoint were turned off";
    case "failed":
      return `Failed (${status ?? ERROR_LABELS[delivery.lastError ?? ""] ?? delivery.lastError ?? "unknown"})`;
  }
}

const ERROR_LABELS: Readonly<Record<string, string>> = {
  timeout: "no answer in 10 seconds",
  connect: "could not connect",
  unresolved: "host not found",
  address_refused: "the host is a private address",
  url_refused: "not an https URL",
  secret_missing: "its secret is missing: rotate it",
  redirect: "redirects are not followed",
  cancelled: "cancelled",
  queue_full: "the queue was full",
  interrupted: "BiBCode stopped while sending",
};

/** Settings → Agent integrations → Webhooks for one environment. */
export function WebhooksTab({
  environmentId,
  isPrimary,
  supported,
}: {
  readonly environmentId: EnvironmentId;
  readonly isPrimary: boolean;
  /** The server reports its settings (it is connected and new enough). */
  readonly supported: boolean;
}) {
  const enabled = useEnvironmentSettings(environmentId, selectWebhooksEnabled);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [saveError, setSaveError] = useState<string | null>(null);
  const save = async (next: boolean) => {
    setSaveError(null);
    const result = await updateSettings({ enableWebhooks: next } as Partial<UnifiedSettings>);
    setSaveError(commandFailure(result, "save the Webhooks setting"));
  };
  return (
    <>
      <SettingsRow
        title={WEBHOOKS_TITLE}
        description={WEBHOOKS_DESCRIPTION}
        resetAction={
          supported && enabled ? (
            <SettingResetButton label="Webhooks" onClick={() => void save(false)} />
          ) : null
        }
        status={saveError === null ? null : <ErrorLine text={saveError} />}
        control={
          <Switch
            checked={supported && enabled}
            disabled={!supported}
            onCheckedChange={(checked) => void save(checked)}
            aria-label={WEBHOOKS_TITLE}
          />
        }
      />
      <EndpointsRow environmentId={environmentId} enabled={enabled} isPrimary={isPrimary} />
    </>
  );
}

function EndpointsRow({
  environmentId,
  enabled,
  isPrimary,
}: {
  readonly environmentId: EnvironmentId;
  readonly enabled: boolean;
  readonly isPrimary: boolean;
}) {
  const access = usePrimaryAgentAccess();
  // The primary environment's session says whether it may read webhooks; elsewhere the
  // server answers.
  const allowed = !isPrimary || access.canRead;
  const list = useWebhookList(allowed ? environmentId : null);
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState<{ readonly name: string; readonly value: string } | null>(
    null,
  );
  const endpoints = list.data?.endpoints ?? [];
  const max = list.data?.maxEndpoints ?? 20;
  const full = endpoints.length >= max;
  return (
    <SettingsRow
      title="Endpoints"
      description={`Up to ${max}. Each has its own signing secret; a receiver checks the X-BibCode-Signature header with it.`}
      control={
        <Button
          size="xs"
          variant="outline"
          disabled={adding || full || list.data === null}
          onClick={() => setAdding(true)}
        >
          Add endpoint
        </Button>
      }
      status={
        full ? (
          <ReasonLine text={`This environment has ${max} endpoints. Delete one to add another.`} />
        ) : null
      }
    >
      <div className="space-y-3 pt-3 pb-3.5">
        {allowed ? null : (
          <ReasonLine text="Webhooks need an administrator session on this environment." />
        )}
        {list.error !== null && list.data === null ? (
          <ErrorLine
            text={`Could not load the webhooks. ${list.error} Webhooks need an administrator session on this environment.`}
          />
        ) : null}
        {secret !== null ? (
          <SecretNotice name={secret.name} secret={secret.value} onDone={() => setSecret(null)} />
        ) : null}
        {adding ? (
          <EndpointForm
            environmentId={environmentId}
            isPrimary={isPrimary}
            endpoint={null}
            onDone={(created) => {
              setAdding(false);
              if (created !== null) setSecret(created);
              list.refresh();
            }}
          />
        ) : null}
        {list.data !== null && endpoints.length === 0 && !adding ? (
          <p className="text-xs text-muted-foreground">No endpoints yet.</p>
        ) : null}
        {endpoints.length > 0 ? (
          <ul className="divide-y divide-border/60 rounded-lg border border-border/60">
            {endpoints.map((endpoint) => (
              <EndpointItem
                key={endpoint.id}
                environmentId={environmentId}
                endpoint={endpoint}
                webhooksOn={enabled}
                isPrimary={isPrimary}
                onChanged={list.refresh}
                onSecret={(value) => setSecret({ name: endpoint.name, value })}
              />
            ))}
          </ul>
        ) : null}
      </div>
    </SettingsRow>
  );
}

function SecretNotice({
  name,
  secret,
  onDone,
}: {
  readonly name: string;
  readonly secret: string;
  readonly onDone: () => void;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  return (
    <div
      role="status"
      className="space-y-2 rounded-lg border border-border/60 bg-muted/40 px-3 py-2.5"
    >
      <p className="text-xs font-medium text-foreground">
        Signing secret for {name}. Copy it now: it is not shown again.
      </p>
      <code
        aria-label="Signing secret"
        className="block overflow-x-auto rounded-md bg-background px-2.5 py-2 font-mono text-xs break-all text-foreground"
      >
        {secret}
      </code>
      <div className="flex flex-wrap gap-2">
        <Button size="xs" variant="outline" onClick={() => copyToClipboard(secret, undefined)}>
          {isCopied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
          {isCopied ? "Copied" : "Copy"}
        </Button>
        <Button size="xs" variant="ghost" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

function EndpointItem({
  environmentId,
  endpoint,
  webhooksOn,
  isPrimary,
  onChanged,
  onSecret,
}: {
  readonly environmentId: EnvironmentId;
  readonly endpoint: WebhookEndpoint;
  readonly webhooksOn: boolean;
  readonly isPrimary: boolean;
  readonly onChanged: () => void;
  readonly onSecret: (secret: string) => void;
}) {
  const upsert = useAtomCommand(webhooksEnvironment.upsert, { reportFailure: false });
  const remove = useAtomCommand(webhooksEnvironment.remove, { reportFailure: false });
  const rotate = useAtomCommand(webhooksEnvironment.rotateSecret, { reportFailure: false });
  const sendTest = useAtomCommand(webhooksEnvironment.sendTest, { reportFailure: false });
  const [editing, setEditing] = useState(false);
  const [showDeliveries, setShowDeliveries] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ readonly text: string; readonly error: boolean } | null>(
    null,
  );
  const offReasonId = useId();
  const failing = isFailingEndpoint(endpoint);

  const run = async <A,>(
    what: string,
    action: () => Promise<AtomCommandResult<A, unknown>>,
    onSuccess?: (value: A) => void,
  ) => {
    setBusy(what);
    setMessage(null);
    const result = await action();
    setBusy(null);
    const failure = commandFailure(result, what);
    if (failure !== null) {
      setMessage({ text: failure, error: true });
      return;
    }
    if (result._tag === "Success") onSuccess?.(result.value);
    onChanged();
  };

  const setEnabled = (next: boolean) =>
    run(next ? "turn the endpoint on" : "turn the endpoint off", () =>
      upsert({
        environmentId,
        input: {
          id: endpoint.id,
          name: endpoint.name,
          url: endpoint.url,
          enabled: next,
          eventTypes: endpoint.eventTypes,
          projectId: endpoint.projectId,
          pairedClientId: endpoint.pairedClientId,
        },
      }),
    );

  if (editing) {
    return (
      <li className="px-3 py-3">
        <EndpointForm
          environmentId={environmentId}
          isPrimary={isPrimary}
          endpoint={endpoint}
          onDone={() => {
            setEditing(false);
            onChanged();
          }}
        />
      </li>
    );
  }

  return (
    <li className="space-y-2 px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <div className="text-[13px] font-medium text-foreground">{endpoint.name}</div>
          <div className="truncate font-mono text-xs text-muted-foreground" title={endpoint.url}>
            {endpoint.url}
          </div>
          <div
            className={
              failing
                ? "flex items-start gap-1.5 text-xs text-destructive"
                : "text-xs text-muted-foreground"
            }
          >
            {failing ? (
              <TriangleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            ) : null}
            <span>{endpointStatusText(endpoint)}</span>
          </div>
        </div>
        <Switch
          checked={endpoint.enabled}
          disabled={busy !== null}
          onCheckedChange={(checked) => void setEnabled(checked)}
          aria-label={`${endpoint.name} on`}
        />
      </div>
      {endpoint.disabledReason !== null ? (
        <Button
          size="xs"
          variant="outline"
          disabled={busy !== null}
          onClick={() => void setEnabled(true)}
        >
          Re-enable
        </Button>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          size="xs"
          variant="outline"
          disabled={!webhooksOn || busy !== null}
          aria-describedby={webhooksOn ? undefined : offReasonId}
          onClick={() =>
            void run(
              "send the test event",
              () => sendTest({ environmentId, input: { id: endpoint.id } }),
              (value) =>
                setMessage({
                  text: `Test event: ${deliveryStatusText(value.delivery)}.`,
                  error: value.delivery.state !== "delivered",
                }),
            )
          }
        >
          {busy === "send the test event" ? "Sending…" : "Send test event"}
        </Button>
        <Button
          size="xs"
          variant="outline"
          aria-expanded={showDeliveries}
          onClick={() => setShowDeliveries((shown) => !shown)}
        >
          {showDeliveries ? "Hide deliveries" : "Recent deliveries"}
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={busy !== null}
          onClick={() => setEditing(true)}
        >
          Edit
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={busy !== null}
          onClick={() =>
            void run(
              "rotate the secret",
              () => rotate({ environmentId, input: { id: endpoint.id } }),
              (value) => onSecret(value.secret),
            )
          }
        >
          Rotate secret
        </Button>
        <Button
          size="xs"
          variant="destructive-outline"
          disabled={busy !== null}
          onClick={() => setConfirmDelete(true)}
        >
          Delete
        </Button>
      </div>
      {webhooksOn ? null : <ReasonLine id={offReasonId} text={WEBHOOKS_OFF_MESSAGE} />}
      {message === null ? null : message.error ? (
        <ErrorLine text={message.text} />
      ) : (
        <p role="status" className="text-xs text-muted-foreground">
          {message.text}
        </p>
      )}
      {showDeliveries ? (
        <DeliveriesList
          environmentId={environmentId}
          endpointId={endpoint.id}
          canRedeliver={webhooksOn && endpoint.enabled}
          reason={webhooksOn ? "Turn this endpoint on first." : WEBHOOKS_OFF_MESSAGE}
        />
      ) : null}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete endpoint “{endpoint.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Its delivery log and signing secret are deleted with it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmDelete(false);
                void run("delete the endpoint", () =>
                  remove({ environmentId, input: { id: endpoint.id } }),
                );
              }}
            >
              Delete endpoint
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </li>
  );
}

function DeliveriesList({
  environmentId,
  endpointId,
  canRedeliver,
  reason,
}: {
  readonly environmentId: EnvironmentId;
  readonly endpointId: string;
  readonly canRedeliver: boolean;
  readonly reason: string;
}) {
  const query = useEnvironmentQuery(
    webhooksEnvironment.deliveries({
      environmentId,
      input: { endpointId, limit: DELIVERIES_SHOWN },
    }),
  );
  const redeliver = useAtomCommand(webhooksEnvironment.redeliver, { reportFailure: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reasonId = useId();
  const deliveries = query.data?.deliveries ?? [];
  if (query.data === null) {
    return query.error === null ? (
      <p className="text-xs text-muted-foreground">Loading deliveries…</p>
    ) : (
      <ErrorLine text={`Could not load the deliveries. ${query.error}`} />
    );
  }
  if (deliveries.length === 0) {
    return <p className="text-xs text-muted-foreground">Nothing sent yet.</p>;
  }
  return (
    <div className="space-y-1.5">
      {canRedeliver ? null : <ReasonLine id={reasonId} text={reason} />}
      {error === null ? null : <ErrorLine text={error} />}
      <table className="w-full text-left text-xs tabular-nums">
        <thead className="text-muted-foreground">
          <tr>
            <th className="py-1 pr-2 font-medium">Time</th>
            <th className="py-1 pr-2 font-medium">Event</th>
            <th className="py-1 pr-2 font-medium">Status</th>
            <th className="py-1 pr-2 font-medium">Attempts</th>
            <th className="py-1 pr-2 font-medium">Latency</th>
            <th className="py-1 font-medium">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">
          {deliveries.map((delivery) => (
            <tr key={delivery.deliveryId}>
              <td className="py-1.5 pr-2 whitespace-nowrap">{timeText(delivery.createdAt)}</td>
              <td className="py-1.5 pr-2 font-mono">{delivery.eventType}</td>
              <td className="py-1.5 pr-2">{deliveryStatusText(delivery)}</td>
              <td className="py-1.5 pr-2">{delivery.attempts}</td>
              <td className="py-1.5 pr-2">
                {delivery.latencyMs === null ? "—" : `${delivery.latencyMs} ms`}
              </td>
              <td className="py-1.5 text-right">
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={
                    !canRedeliver ||
                    busy !== null ||
                    delivery.state === "pending" ||
                    delivery.state === "sending"
                  }
                  aria-describedby={canRedeliver ? undefined : reasonId}
                  onClick={async () => {
                    setBusy(delivery.deliveryId);
                    setError(null);
                    const result = await redeliver({
                      environmentId,
                      input: { deliveryId: delivery.deliveryId },
                    });
                    setBusy(null);
                    setError(commandFailure(result, "redeliver"));
                    query.refresh();
                  }}
                >
                  {busy === delivery.deliveryId ? "Sending…" : "Redeliver"}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Add (no `endpoint`) or edit an endpoint; `onDone` receives a new endpoint's secret. */
function EndpointForm({
  environmentId,
  isPrimary,
  endpoint,
  onDone,
}: {
  readonly environmentId: EnvironmentId;
  readonly isPrimary: boolean;
  readonly endpoint: WebhookEndpoint | null;
  readonly onDone: (created: { readonly name: string; readonly value: string } | null) => void;
}) {
  const upsert = useAtomCommand(webhooksEnvironment.upsert, { reportFailure: false });
  const allProjects = useProjects();
  const projects = useMemo(
    () => allProjects.filter((project) => project.environmentId === environmentId),
    [allProjects, environmentId],
  );
  const [name, setName] = useState(endpoint?.name ?? "");
  const [url, setUrl] = useState(endpoint?.url ?? "");
  const [events, setEvents] = useState<ReadonlySet<WebhookEventType>>(
    () => new Set(endpoint?.eventTypes ?? ALL_EVENTS),
  );
  const [projectId, setProjectId] = useState<string | null>(endpoint?.projectId ?? null);
  const [pairedClientId, setPairedClientId] = useState<string | null>(
    endpoint?.pairedClientId ?? null,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const urlId = useId();
  const urlValid = HTTPS_URL.test(url.trim());
  const canSave = name.trim().length > 0 && urlValid && events.size > 0 && !saving;

  const toggle = (event: WebhookEventType, checked: boolean) =>
    setEvents((current) => {
      const next = new Set(current);
      if (checked) next.add(event);
      else next.delete(event);
      return next;
    });

  const submit = async () => {
    setSaving(true);
    setError(null);
    const result = await upsert({
      environmentId,
      input: {
        ...(endpoint === null ? {} : { id: endpoint.id }),
        name: name.trim(),
        url: url.trim(),
        enabled: endpoint?.enabled ?? true,
        eventTypes: ALL_EVENTS.filter((event) => events.has(event)),
        projectId,
        pairedClientId,
      },
    });
    setSaving(false);
    const failure = commandFailure(result, endpoint === null ? "add the endpoint" : "save");
    if (failure !== null) {
      setError(failure);
      return;
    }
    const secret = result._tag === "Success" ? result.value.secret : undefined;
    onDone(secret === undefined ? null : { name: name.trim(), value: secret });
  };

  return (
    <form
      className="space-y-3 rounded-lg border border-border/60 px-3 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSave) void submit();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1" htmlFor={nameId}>
          <span className="text-xs font-medium text-foreground">Name</span>
          <Input
            id={nameId}
            value={name}
            maxLength={80}
            placeholder="CI notifications"
            onChange={(event) => setName(event.currentTarget.value)}
          />
        </label>
        <label className="space-y-1" htmlFor={urlId}>
          <span className="text-xs font-medium text-foreground">HTTPS URL</span>
          <Input
            id={urlId}
            value={url}
            inputMode="url"
            placeholder="https://hooks.example.com/bibcode"
            aria-invalid={url.trim().length > 0 && !urlValid}
            onChange={(event) => setUrl(event.currentTarget.value)}
          />
        </label>
      </div>
      {url.trim().length > 0 && !urlValid ? (
        <ReasonLine text="Use an https:// URL. Private network addresses are refused when sending." />
      ) : null}
      <fieldset className="space-y-2">
        <legend className="text-xs font-medium text-foreground">Send these events</legend>
        <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
          {WEBHOOK_EVENT_CATEGORIES.map((category) => (
            <div key={category.key} className="space-y-1.5">
              <div className="text-xs text-muted-foreground">
                {CATEGORY_LABELS[category.key] ?? category.key}
              </div>
              {category.events.map((event) => (
                <label key={event} className="flex items-center gap-2 text-xs text-foreground">
                  <Checkbox
                    checked={events.has(event)}
                    onCheckedChange={(checked) => toggle(event, checked === true)}
                  />
                  {EVENT_LABELS[event]}
                </label>
              ))}
            </div>
          ))}
        </div>
        {events.size === 0 ? <ReasonLine text="Choose at least one event." /> : null}
        {events.has("profiler.finding") ? (
          <p className="text-xs text-muted-foreground">
            Profiler findings are sent only while MCP agents may use Diagnostics.
          </p>
        ) : null}
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <span className="text-xs font-medium text-foreground">Project</span>
          <Select
            value={projectId ?? NO_PROJECT}
            onValueChange={(next) => setProjectId(next === NO_PROJECT ? null : String(next))}
          >
            <SelectTrigger aria-label="Project" className="w-full">
              <SelectValue>
                {projects.find((project) => project.id === projectId)?.title ?? "All projects"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem hideIndicator value={NO_PROJECT}>
                All projects
              </SelectItem>
              {projects.map((project) => (
                <SelectItem hideIndicator key={project.id} value={project.id}>
                  {project.title}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        {isPrimary ? (
          <PairedClientSelect value={pairedClientId} onChange={setPairedClientId} />
        ) : null}
      </div>
      {error === null ? null : <ErrorLine text={error} />}
      <div className="flex gap-2">
        <Button size="xs" type="submit" disabled={!canSave}>
          {saving ? "Saving…" : endpoint === null ? "Add endpoint" : "Save"}
        </Button>
        <Button size="xs" variant="ghost" type="button" onClick={() => onDone(null)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** The outside agent an endpoint follows: revoking it turns the endpoint off. */
function PairedClientSelect({
  value,
  onChange,
}: {
  readonly value: string | null;
  readonly onChange: (next: string | null) => void;
}) {
  const clients = usePrimaryMcpClients();
  const label = (sessionId: string) =>
    clients.find((client) => client.sessionId === sessionId)?.client.label ?? "MCP agent";
  return (
    <div className="space-y-1">
      <span className="text-xs font-medium text-foreground">Paired MCP client</span>
      <Select
        value={value ?? NO_PROJECT}
        onValueChange={(next) => onChange(next === NO_PROJECT ? null : String(next))}
      >
        <SelectTrigger aria-label="Paired MCP client" className="w-full">
          <SelectValue>{value === null ? "None" : label(value)}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          <SelectItem hideIndicator value={NO_PROJECT}>
            None
          </SelectItem>
          {clients.map((client) => (
            <SelectItem hideIndicator key={client.sessionId} value={client.sessionId}>
              {client.client.label ?? "MCP agent"}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <p className="text-xs text-muted-foreground">Revoking that client turns this endpoint off.</p>
    </div>
  );
}

function ReasonLine({ id, text }: { readonly id?: string; readonly text: string }) {
  return (
    <div id={id} className="flex items-start gap-1.5 text-xs text-muted-foreground">
      <InfoIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span>{text}</span>
    </div>
  );
}

function ErrorLine({ text }: { readonly text: string }) {
  return (
    <div role="alert" className="flex items-start gap-1.5 text-xs text-destructive">
      <TriangleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span>{text}</span>
    </div>
  );
}
