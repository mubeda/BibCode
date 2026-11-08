// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type AnyProps = Record<string, unknown>;
type Call = { command: string; request: { environmentId: string; input: AnyProps } };

const h = vi.hoisted(() => ({
  settings: { enableWebhooks: false } as Record<string, unknown>,
  updates: [] as unknown[],
  copied: [] as string[],
  endpoints: [] as Array<Record<string, unknown>>,
  deliveries: [] as Array<Record<string, unknown>>,
  calls: [] as Call[],
  results: {} as Record<string, unknown>,
}));

vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: (_environmentId: string, selector: (settings: unknown) => unknown) =>
    selector(h.settings),
  useUpdateEnvironmentSettings: () => (patch: unknown) => {
    h.updates.push(patch);
    return Promise.resolve({ _tag: "Success", value: undefined });
  },
}));

vi.mock("../../hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({
    copyToClipboard: (text: string) => h.copied.push(text),
    isCopied: false,
  }),
}));

vi.mock("../../state/webhooks", () => ({
  useWebhookList: () => ({
    data: { enabled: h.settings.enableWebhooks, endpoints: h.endpoints, maxEndpoints: 20 },
    error: null,
    refresh: () => undefined,
  }),
  isFailingEndpoint: (endpoint: {
    disabledReason: unknown;
    enabled: boolean;
    consecutiveFailures: number;
  }) => endpoint.disabledReason !== null || (endpoint.enabled && endpoint.consecutiveFailures > 0),
  webhooksEnvironment: {
    upsert: "upsert",
    remove: "remove",
    rotateSecret: "rotateSecret",
    sendTest: "sendTest",
    redeliver: "redeliver",
    deliveries: (target: unknown) => ({ deliveries: target }),
  },
}));

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { deliveries: h.deliveries },
    error: null,
    refresh: () => undefined,
  }),
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (request: Call["request"]) => {
    h.calls.push({ command, request });
    return Promise.resolve(h.results[command] ?? { _tag: "Success", value: {} });
  },
}));

vi.mock("../../state/entities", () => ({
  useProjects: () => [{ id: "p1", title: "App", environmentId: "local" }],
}));

vi.mock("../../state/mcpActivity", () => ({
  usePrimaryMcpClients: () => [],
  usePrimaryAgentAccess: () => ({ environmentId: "local", canRead: true, canManage: true }),
}));

vi.mock("../ui/switch", () => ({
  Switch: (props: AnyProps) => (
    <button
      type="button"
      role="switch"
      aria-label={props["aria-label"] as string}
      aria-checked={Boolean(props.checked)}
      disabled={Boolean(props.disabled)}
      onClick={() => (props.onCheckedChange as (checked: boolean) => void)(!props.checked)}
    />
  ),
}));

vi.mock("../ui/checkbox", () => ({
  Checkbox: (props: AnyProps) => (
    <input
      type="checkbox"
      checked={Boolean(props.checked)}
      onChange={(event) =>
        (props.onCheckedChange as (checked: boolean) => void)(event.currentTarget.checked)
      }
    />
  ),
}));

vi.mock("../ui/select", () => ({
  Select: (props: AnyProps) => <div>{props.children as ReactNode}</div>,
  SelectTrigger: (props: AnyProps) => (
    <button type="button" aria-label={props["aria-label"] as string}>
      {props.children as ReactNode}
    </button>
  ),
  SelectValue: (props: AnyProps) => <span>{props.children as ReactNode}</span>,
  SelectPopup: () => null,
  SelectItem: () => null,
}));

vi.mock("../ui/alert-dialog", () => ({
  AlertDialog: (props: AnyProps) =>
    props.open ? <div role="alertdialog">{props.children as ReactNode}</div> : null,
  AlertDialogPopup: (props: AnyProps) => <div>{props.children as ReactNode}</div>,
  AlertDialogHeader: (props: AnyProps) => <div>{props.children as ReactNode}</div>,
  AlertDialogFooter: (props: AnyProps) => <div>{props.children as ReactNode}</div>,
  AlertDialogTitle: (props: AnyProps) => <h2>{props.children as ReactNode}</h2>,
  AlertDialogDescription: (props: AnyProps) => <p>{props.children as ReactNode}</p>,
  AlertDialogClose: (props: AnyProps) => (
    <button type="button" onClick={() => undefined}>
      {props.children as ReactNode}
    </button>
  ),
}));

import { WebhooksTab } from "./WebhooksTab";

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

async function render({
  questionEvents = true,
  bearerToken = true,
  statusKinds = true,
} = {}): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(
      <WebhooksTab
        environmentId={"local" as never}
        isPrimary={true}
        supported={true}
        capabilities={{
          webhookQuestionEvents: questionEvents,
          webhookBearerToken: bearerToken,
          webhookStatusKinds: statusKinds,
        }}
      />,
    );
  });
  return container;
}

function submitButton(container: HTMLElement): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('form button[type="submit"]')!;
}

function endpoint(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "w1",
    name: "CI",
    url: "https://hooks.example.com/bibcode",
    enabled: true,
    eventTypes: ["thread.status_changed"],
    projectId: null,
    pairedClientId: null,
    bearerTokenSet: false,
    statusKinds: null,
    consecutiveFailures: 0,
    disabledReason: null,
    pendingDeliveries: 0,
    lastDeliveryState: null,
    droppedDeliveries: 0,
    createdAt: "2026-10-31T00:00:00Z",
    updatedAt: "2026-10-31T00:00:00Z",
    ...overrides,
  };
}

function button(container: HTMLElement, text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === text,
  );
  if (found === undefined) throw new Error(`no button ${text}`);
  return found;
}

function statusKindBoxes(container: HTMLElement): HTMLInputElement[] {
  return [
    ...container
      .querySelector('[role="group"][aria-label="Status changes sent"]')!
      .querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  ];
}

function eventBox(container: HTMLElement, label: string): HTMLInputElement {
  const found = [...container.querySelectorAll("label")].find(
    (candidate) => candidate.textContent === label,
  );
  if (found === undefined) throw new Error(`no event ${label}`);
  return found.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
}

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  h.settings = { enableWebhooks: false };
  h.updates = [];
  h.copied = [];
  h.endpoints = [];
  h.deliveries = [];
  h.calls = [];
  h.results = {};
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe("WebhooksTab", () => {
  it("starts off and turns webhooks on without asking", async () => {
    const container = await render();
    const toggle = container.querySelector<HTMLButtonElement>('[aria-label="Webhooks"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).toContain("never prompts, messages or file contents");
    expect(container.textContent).toContain("No endpoints yet.");
    await act(async () => toggle.click());
    expect(h.updates).toEqual([{ enableWebhooks: true }]);
  });

  it("explains why Send test event is disabled while webhooks are off", async () => {
    h.endpoints = [endpoint()];
    const container = await render();
    const send = button(container, "Send test event");
    expect(send.disabled).toBe(true);
    expect(
      container.querySelector(`[id="${send.getAttribute("aria-describedby")}"]`)?.textContent,
    ).toBe("Turn on Webhooks first.");
  });

  it("adds an endpoint with every event and shows its secret once", async () => {
    h.settings = { enableWebhooks: true };
    h.results.upsert = {
      _tag: "Success",
      value: { endpoint: endpoint(), secret: "whsec_0123" },
    };
    const container = await render();
    await act(async () => button(container, "Add endpoint").click());
    const inputs = container.querySelectorAll<HTMLInputElement>("form input:not([type])");
    await act(async () => {
      setInput(inputs[0]!, "CI");
      setInput(inputs[1]!, "https://hooks.example.com/bibcode");
    });
    const submit = [
      ...container.querySelectorAll<HTMLButtonElement>('form button[type="submit"]'),
    ][0]!;
    await act(async () => submit.click());
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.command).toBe("upsert");
    expect(h.calls[0]!.request.input).toMatchObject({
      name: "CI",
      url: "https://hooks.example.com/bibcode",
      enabled: true,
      projectId: null,
      pairedClientId: null,
    });
    expect(h.calls[0]!.request.input.eventTypes).toHaveLength(12);
    expect(container.querySelector('[aria-label="Signing secret"]')?.textContent).toBe(
      "whsec_0123",
    );
    expect(container.textContent).toContain("it is not shown again");
    await act(async () => button(container, "Copy").click());
    expect(h.copied).toEqual(["whsec_0123"]);
    await act(async () => button(container, "Done").click());
    expect(container.querySelector('[aria-label="Signing secret"]')).toBeNull();
  });

  it("offers the Questions events and leaves them out for an older server", async () => {
    h.settings = { enableWebhooks: true };
    const container = await render();
    await act(async () => button(container, "Add endpoint").click());
    expect(container.textContent).toContain("Questions");
    expect(container.textContent).toContain("Question asked");
    expect(container.textContent).toContain("Question answered");
    expect(container.textContent).not.toContain("Update BiBCode on this environment");

    const older = await render({ questionEvents: false });
    await act(async () => button(older, "Add endpoint").click());
    expect(older.textContent).not.toContain("Question asked");
    expect(older.textContent).toContain(
      "Update BiBCode on this environment to send question events.",
    );
    const inputs = older.querySelectorAll<HTMLInputElement>("form input:not([type])");
    await act(async () => {
      setInput(inputs[0]!, "CI");
      setInput(inputs[1]!, "https://hooks.example.com/bibcode");
    });
    await act(async () => submitButton(older).click());
    const sent = h.calls[0]!.request.input.eventTypes as string[];
    expect(sent).toHaveLength(10);
    expect(sent).not.toContain("input.requested");
  });

  it("saves back event types it does not know", async () => {
    h.settings = { enableWebhooks: true };
    h.endpoints = [endpoint({ eventTypes: ["thread.status_changed", "future.event"] })];
    const container = await render();
    await act(async () => button(container, "Edit").click());
    await act(async () => submitButton(container).click());
    expect(h.calls[0]!.request.input.eventTypes).toEqual(["thread.status_changed", "future.event"]);
  });

  it("adds an endpoint with a masked bearer token that is gone from the page once saved", async () => {
    h.settings = { enableWebhooks: true };
    const container = await render();
    await act(async () => button(container, "Add endpoint").click());
    const inputs = container.querySelectorAll<HTMLInputElement>("form input:not([type])");
    const token = container.querySelector<HTMLInputElement>('form input[type="password"]')!;
    expect(token.getAttribute("autocomplete")).toBe("off");
    expect(container.textContent).toContain("Sent as Authorization: Bearer");
    await act(async () => {
      setInput(inputs[0]!, "CI");
      setInput(inputs[1]!, "https://hooks.example.com/bibcode");
      setInput(token, "  tok-secret-1  ");
    });
    await act(async () => submitButton(container).click());
    expect(h.calls[0]!.request.input.bearerToken).toBe("tok-secret-1");
    expect(container.querySelector("form")).toBeNull();
    expect(container.innerHTML).not.toContain("tok-secret-1");
  });

  it("keeps, replaces and removes an endpoint's token", async () => {
    h.settings = { enableWebhooks: true };
    h.endpoints = [endpoint({ bearerTokenSet: true })];
    const container = await render();
    // Untouched, the token is kept: the field is left out.
    await act(async () => button(container, "Edit").click());
    expect(container.textContent).toContain("A token is set.");
    expect(container.querySelector('input[type="password"]')).toBeNull();
    await act(async () => submitButton(container).click());
    expect("bearerToken" in h.calls[0]!.request.input).toBe(false);

    await act(async () => button(container, "Edit").click());
    await act(async () => button(container, "Replace").click());
    expect(submitButton(container).disabled).toBe(true);
    expect(container.textContent).toContain("Enter the new token, or keep the current one.");
    await act(async () =>
      setInput(container.querySelector<HTMLInputElement>('input[type="password"]')!, "tok-2"),
    );
    await act(async () => submitButton(container).click());
    expect(h.calls[1]!.request.input.bearerToken).toBe("tok-2");
    expect(container.innerHTML).not.toContain("tok-2");

    await act(async () => button(container, "Edit").click());
    await act(async () => button(container, "Remove").click());
    expect(container.textContent).toContain("The token is removed when you save.");
    await act(async () => submitButton(container).click());
    expect(h.calls[2]!.request.input.bearerToken).toBeNull();
  });

  it("names an idle named client's pairing and saves its id back unchanged", async () => {
    h.settings = { enableWebhooks: true };
    h.endpoints = [endpoint({ pairedClientId: "nc_1", pairedClientName: "builder" })];
    const container = await render();
    await act(async () => button(container, "Edit").click());
    const trigger = container.querySelector('[aria-label="Paired MCP client"]')!;
    expect(trigger.textContent).toBe("builder");
    expect(container.textContent).toContain(
      "A named client's endpoint stays on across its restarts.",
    );
    await act(async () => submitButton(container).click());
    expect(h.calls[0]!.request.input.pairedClientId).toBe("nc_1");
  });

  it("asks for the token again when the URL changes", async () => {
    h.settings = { enableWebhooks: true };
    h.endpoints = [endpoint({ bearerTokenSet: true })];
    const container = await render();
    await act(async () => button(container, "Edit").click());
    const url = container.querySelectorAll<HTMLInputElement>("form input:not([type])")[1]!;
    await act(async () => setInput(url, "https://other.example.com/hook"));
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    expect(submitButton(container).disabled).toBe(true);
    expect(container.textContent).toContain("Enter the token for the new URL, or remove it.");
    await act(async () => button(container, "Remove").click());
    expect(submitButton(container).disabled).toBe(false);
    await act(async () => submitButton(container).click());
    expect(h.calls[0]!.request.input).toMatchObject({
      url: "https://other.example.com/hook",
      bearerToken: null,
    });
  });

  it("hides the token field on an older server and never sends it", async () => {
    h.settings = { enableWebhooks: true };
    const container = await render({ bearerToken: false });
    await act(async () => button(container, "Add endpoint").click());
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.textContent).toContain(
      "Update BiBCode on this environment to send a bearer token.",
    );
    const inputs = container.querySelectorAll<HTMLInputElement>("form input:not([type])");
    await act(async () => {
      setInput(inputs[0]!, "CI");
      setInput(inputs[1]!, "https://hooks.example.com/bibcode");
    });
    await act(async () => submitButton(container).click());
    expect("bearerToken" in h.calls[0]!.request.input).toBe(false);
  });

  it("sends only the status changes chosen, and every one by default", async () => {
    h.settings = { enableWebhooks: true };
    h.endpoints = [endpoint()];
    const container = await render();
    await act(async () => button(container, "Edit").click());
    const group = container.querySelector('[role="group"][aria-label="Status changes sent"]')!;
    const kinds = [...group.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(group.textContent).toContain("Turn started");
    expect(kinds.every((kind) => kind.checked)).toBe(true);
    await act(async () => submitButton(container).click());
    expect(h.calls[0]!.request.input.statusKinds).toBeNull();

    await act(async () => button(container, "Edit").click());
    const again = [
      ...container
        .querySelector('[role="group"][aria-label="Status changes sent"]')!
        .querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ];
    // Leave out "Turn started".
    await act(async () => again[0]!.click());
    await act(async () => submitButton(container).click());
    expect(h.calls[1]!.request.input.statusKinds).toEqual([
      "turn.completed",
      "turn.interrupted",
      "turn.failed",
      "session.status",
    ]);
  });

  it("asks for at least one status change and keeps kinds it does not know", async () => {
    h.settings = { enableWebhooks: true };
    h.endpoints = [endpoint({ statusKinds: ["turn.failed"] })];
    const container = await render();
    await act(async () => button(container, "Edit").click());
    expect(statusKindBoxes(container).map((kind) => kind.checked)).toEqual([
      false,
      false,
      false,
      true,
      false,
    ]);
    await act(async () => statusKindBoxes(container)[3]!.click());
    expect(submitButton(container).disabled).toBe(true);
    expect(container.textContent).toContain(
      "Choose at least one status change, or stop sending Thread status changed.",
    );
    await act(async () => statusKindBoxes(container)[1]!.click());
    await act(async () => submitButton(container).click());
    expect(h.calls[0]!.request.input.statusKinds).toEqual(["turn.completed"]);
  });

  it("saves a filter that holds only kinds a newer server added", async () => {
    h.settings = { enableWebhooks: true };
    h.endpoints = [endpoint({ statusKinds: ["turn.failed", "future.kind"] })];
    const container = await render();
    await act(async () => button(container, "Edit").click());
    await act(async () => statusKindBoxes(container)[3]!.click());
    expect(submitButton(container).disabled).toBe(false);
    expect(container.textContent).not.toContain("Choose at least one status change");
    await act(async () => submitButton(container).click());
    expect(h.calls[0]!.request.input.statusKinds).toEqual(["future.kind"]);
  });

  it("keeps the stored filter when every kind is cleared and the event is turned off", async () => {
    h.settings = { enableWebhooks: true };
    h.endpoints = [
      endpoint({
        eventTypes: ["thread.status_changed", "approval.requested"],
        statusKinds: ["turn.failed"],
      }),
    ];
    const container = await render();
    await act(async () => button(container, "Edit").click());
    await act(async () => statusKindBoxes(container)[3]!.click());
    await act(async () => eventBox(container, "Thread status changed").click());
    expect(submitButton(container).disabled).toBe(false);
    await act(async () => submitButton(container).click());
    expect(h.calls[0]!.request.input.eventTypes).toEqual(["approval.requested"]);
    expect("statusKinds" in h.calls[0]!.request.input).toBe(false);
  });

  it("hides the status choices on an older server and never sends them", async () => {
    h.settings = { enableWebhooks: true };
    h.endpoints = [endpoint()];
    const container = await render({ statusKinds: false });
    await act(async () => button(container, "Edit").click());
    expect(container.querySelector('[aria-label="Status changes sent"]')).toBeNull();
    expect(container.textContent).toContain(
      "Update BiBCode on this environment to choose which status changes are sent.",
    );
    await act(async () => submitButton(container).click());
    expect("statusKinds" in h.calls[0]!.request.input).toBe(false);
  });

  it("refuses to submit a URL that is not https", async () => {
    const container = await render();
    await act(async () => button(container, "Add endpoint").click());
    const inputs = container.querySelectorAll<HTMLInputElement>("form input:not([type])");
    await act(async () => {
      setInput(inputs[0]!, "CI");
      setInput(inputs[1]!, "http://hooks.example.com/bibcode");
    });
    const submit = container.querySelector<HTMLButtonElement>('form button[type="submit"]')!;
    expect(submit.disabled).toBe(true);
    expect(container.textContent).toContain("Use an https:// URL.");
  });

  it("warns about an endpoint turned off by failures and re-enables it", async () => {
    h.settings = { enableWebhooks: true };
    h.endpoints = [
      endpoint({ enabled: false, disabledReason: "failures", consecutiveFailures: 10 }),
    ];
    const container = await render();
    expect(container.textContent).toContain("Turned off after 10 failed deliveries");
    await act(async () => button(container, "Re-enable").click());
    expect(h.calls[0]).toMatchObject({
      command: "upsert",
      request: { environmentId: "local", input: { id: "w1", enabled: true } },
    });
  });

  it("says when deliveries were dropped from a full queue or by an edit", async () => {
    h.settings = { enableWebhooks: true };
    h.endpoints = [endpoint({ droppedDeliveries: 3 })];
    h.deliveries = [
      {
        deliveryId: "d3",
        eventId: "ev_3",
        eventType: "thread.status_changed",
        state: "abandoned",
        attempts: 0,
        lastStatus: null,
        lastError: "endpoint_changed",
        latencyMs: null,
        nextAttemptAt: null,
        createdAt: "2026-10-31T00:00:00Z",
        updatedAt: "2026-10-31T00:00:00Z",
      },
    ];
    const container = await render();
    expect(container.textContent).toContain("On · 3 deliveries dropped when the queue was full");
    await act(async () => button(container, "Recent deliveries").click());
    expect(container.textContent).toContain("Not sent: the endpoint's URL or events changed");
    expect(button(container, "Redeliver").disabled).toBe(false);
  });

  it("asks before deleting an endpoint, since its delivery log goes with it", async () => {
    h.endpoints = [endpoint()];
    const container = await render();
    await act(async () => button(container, "Delete").click());
    expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain(
      "Its delivery log and signing secret are deleted with it.",
    );
    expect(h.calls).toEqual([]);
    await act(async () => button(container, "Delete endpoint").click());
    expect(h.calls).toEqual([
      { command: "remove", request: { environmentId: "local", input: { id: "w1" } } },
    ]);
  });

  it("lists recent deliveries and redelivers one", async () => {
    h.settings = { enableWebhooks: true };
    h.endpoints = [endpoint()];
    h.deliveries = [
      {
        deliveryId: "d1",
        eventId: "ev_1",
        eventType: "thread.status_changed",
        state: "failed",
        attempts: 6,
        lastStatus: 500,
        lastError: "status",
        latencyMs: 120,
        nextAttemptAt: null,
        createdAt: "2026-10-31T00:00:00Z",
        updatedAt: "2026-10-31T00:30:00Z",
      },
    ];
    const container = await render();
    await act(async () => button(container, "Recent deliveries").click());
    expect(container.textContent).toContain("Failed (HTTP 500)");
    expect(container.textContent).toContain("120 ms");
    await act(async () => button(container, "Redeliver").click());
    expect(h.calls).toEqual([
      { command: "redeliver", request: { environmentId: "local", input: { deliveryId: "d1" } } },
    ]);
  });

  it("does not redeliver a delivery that is still queued", async () => {
    h.settings = { enableWebhooks: true };
    h.endpoints = [endpoint()];
    h.deliveries = [
      {
        deliveryId: "d2",
        eventId: "ev_2",
        eventType: "approval.requested",
        state: "pending",
        attempts: 1,
        lastStatus: 503,
        lastError: "status",
        latencyMs: 40,
        nextAttemptAt: "2026-10-31T00:01:00Z",
        createdAt: "2026-10-31T00:00:00Z",
        updatedAt: "2026-10-31T00:00:30Z",
      },
    ];
    const container = await render();
    await act(async () => button(container, "Recent deliveries").click());
    expect(container.textContent).toContain("Retrying (HTTP 503)");
    expect(button(container, "Redeliver").disabled).toBe(true);
  });
});
