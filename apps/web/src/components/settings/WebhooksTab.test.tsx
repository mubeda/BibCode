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

vi.mock("../../state/mcpActivity", () => ({ usePrimaryMcpClients: () => [] }));

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

async function render(): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(<WebhooksTab environmentId={"local" as never} isPrimary={true} supported={true} />);
  });
  return container;
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
    consecutiveFailures: 0,
    disabledReason: null,
    pendingDeliveries: 0,
    lastDeliveryState: null,
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
    expect(h.calls[0]!.request.input.eventTypes).toHaveLength(10);
    expect(container.querySelector('[aria-label="Signing secret"]')?.textContent).toBe(
      "whsec_0123",
    );
    expect(container.textContent).toContain("it is not shown again");
    await act(async () => button(container, "Copy").click());
    expect(h.copied).toEqual(["whsec_0123"]);
    await act(async () => button(container, "Done").click());
    expect(container.querySelector('[aria-label="Signing secret"]')).toBeNull();
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
});
